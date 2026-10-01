import type { Types } from 'mongoose';
import { ProjectModel, TimelineEventModel } from '../../models/index.js';
import { notify } from '../notifications/dispatcher.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('timeline');

/**
 * The eleven project stages, in order. `order` drives both the progress bar and
 * the automatic advancement rule: a trigger can only move a project forward,
 * never backwards, so an out-of-order event can never rewind a delivered project.
 */
export const STAGES = [
  { key: 'booking_requested', label: 'Booking Requested', short: 'Requested' },
  { key: 'booking_confirmed', label: 'Booking Confirmed', short: 'Confirmed' },
  { key: 'deposit_paid', label: 'Deposit Paid', short: 'Deposit' },
  { key: 'event_scheduled', label: 'Event Scheduled', short: 'Scheduled' },
  { key: 'session_completed', label: 'Photo Session Completed', short: 'Shoot' },
  { key: 'editing', label: 'Editing', short: 'Editing' },
  { key: 'highlights_ready', label: 'Photo Highlights Ready', short: 'Highlights' },
  { key: 'gallery_published', label: 'Gallery Published', short: 'Gallery' },
  { key: 'album_selection', label: 'Album Selection', short: 'Selection' },
  { key: 'final_delivery', label: 'Final Delivery', short: 'Delivery' },
  { key: 'completed', label: 'Completed', short: 'Done' },
] as const;

export type StageKey = (typeof STAGES)[number]['key'];

export const STAGE_KEYS = STAGES.map((s) => s.key) as StageKey[];

const STAGE_ORDER = new Map<string, number>(STAGES.map((s, index) => [s.key, index + 1]));

export function stageOrder(key: string): number {
  return STAGE_ORDER.get(key) ?? 0;
}

export function stageLabel(key: string): string {
  return STAGES.find((s) => s.key === key)?.label ?? key;
}

/**
 * System events that move the timeline. Keyed by trigger so any service can
 * simply say what happened and let the engine decide the stage.
 */
export type TimelineTrigger =
  | 'BOOKING_CREATED'
  | 'BOOKING_APPROVED'
  | 'PAYMENT_SUCCEEDED'
  | 'EVENT_DATE_REACHED'
  | 'PHOTOS_UPLOADED'
  | 'HIGHLIGHTS_PUBLISHED'
  | 'GALLERY_PUBLISHED'
  | 'SELECTION_COMPLETED'
  | 'FINAL_DELIVERED'
  | 'PROJECT_COMPLETED';

const TRIGGER_STAGE: Record<TimelineTrigger, StageKey> = {
  BOOKING_CREATED: 'booking_requested',
  BOOKING_APPROVED: 'booking_confirmed',
  PAYMENT_SUCCEEDED: 'deposit_paid',
  EVENT_DATE_REACHED: 'session_completed',
  PHOTOS_UPLOADED: 'editing',
  HIGHLIGHTS_PUBLISHED: 'highlights_ready',
  GALLERY_PUBLISHED: 'gallery_published',
  SELECTION_COMPLETED: 'album_selection',
  FINAL_DELIVERED: 'final_delivery',
  PROJECT_COMPLETED: 'completed',
};

const TRIGGER_NOTIFICATION: Partial<Record<TimelineTrigger, 'client' | 'photographer' | 'both'>> = {
  BOOKING_APPROVED: 'both',
  PAYMENT_SUCCEEDED: 'client',
  HIGHLIGHTS_PUBLISHED: 'client',
  GALLERY_PUBLISHED: 'client',
  SELECTION_COMPLETED: 'photographer',
  FINAL_DELIVERED: 'client',
};

export interface AdvanceOptions {
  projectId: Types.ObjectId | string;
  trigger: TimelineTrigger;
  actorId?: Types.ObjectId | null;
  description?: string;
  /** Notifications are skipped for the automatic session-date reconciliation. */
  silent?: boolean;
}

export interface AdvanceResult {
  moved: boolean;
  stage: StageKey;
  from: string;
  to: StageKey;
}

/**
 * Move a project's timeline forward in response to a system event.
 *
 * Idempotent: re-running the same trigger is a no-op, so a webhook retry or a
 * double-clicked button cannot create duplicate timeline entries or duplicate
 * notifications. A partial unique index on (project, stage, automatic) is the
 * backstop.
 */
export async function advance(options: AdvanceOptions): Promise<AdvanceResult> {
  const targetStage = TRIGGER_STAGE[options.trigger];
  const project = await ProjectModel.findById(options.projectId);
  if (!project) {
    log.warn('advance called for a missing project', { projectId: String(options.projectId) });
    return { moved: false, stage: 'booking_requested', from: '', to: targetStage };
  }

  const from = project.timelineStage ?? 'booking_requested';
  const fromOrder = stageOrder(from);
  const toOrder = stageOrder(targetStage);

  // Only ever move forward, and never repeat a stage we have already passed.
  if (toOrder <= fromOrder) {
    return { moved: false, stage: from as StageKey, from, to: targetStage };
  }

  const alreadyRecorded = await TimelineEventModel.findOne({
    projectId: project._id,
    stage: targetStage,
    automatic: true,
  }).lean();
  if (alreadyRecorded) {
    return { moved: false, stage: from as StageKey, from, to: targetStage };
  }

  project.timelineStage = targetStage;
  project.timelineCompletedAt = new Date();
  if (targetStage === 'session_completed') project.status = 'shooting';
  if (targetStage === 'editing') project.status = 'editing';
  if (targetStage === 'final_delivery') project.status = 'delivered';
  if (targetStage === 'completed') project.status = 'completed';
  await project.save();

  await TimelineEventModel.create({
    projectId: project._id,
    photographerId: project.photographerId,
    clientId: project.clientId,
    stage: targetStage,
    title: stageLabel(targetStage),
    description: options.description ?? '',
    automatic: true,
    trigger: options.trigger,
    previousStage: from,
    actorId: options.actorId ?? null,
    visibleToClient: true,
  });

  log.info('timeline advanced', {
    projectId: String(project._id),
    trigger: options.trigger,
    from,
    to: targetStage,
  });

  if (!options.silent) {
    const audience = TRIGGER_NOTIFICATION[options.trigger];
    if (audience) {
      const link = linkForStage(targetStage, String(project._id));
      const title = stageLabel(targetStage);
      const message =
        options.description ??
        defaultStageMessage(targetStage, String(project.title));

      if (audience === 'client' || audience === 'both') {
        void notify({
          userId: project.clientId,
          photographerId: project.photographerId,
          type: notificationTypeFor(targetStage),
          title,
          message,
          link,
          projectId: project._id,
          priority: targetStage === 'highlights_ready' || targetStage === 'gallery_published' ? 'high' : 'normal',
          email: targetStage === 'highlights_ready' || targetStage === 'final_delivery',
        });
      }
      if (audience === 'photographer' || audience === 'both') {
        void notify({
          userId: project.photographerId,
          type: 'timeline_updated',
          title,
          message,
          link,
          projectId: project._id,
        });
      }
    }
  }

  return { moved: true, stage: targetStage, from, to: targetStage };
}

function notificationTypeFor(stage: StageKey) {
  switch (stage) {
    case 'highlights_ready':
      return 'highlights_published' as const;
    case 'gallery_published':
      return 'gallery_published' as const;
    case 'album_selection':
      return 'selection_completed' as const;
    case 'final_delivery':
      return 'timeline_updated' as const;
    default:
      return 'timeline_updated' as const;
  }
}

function linkForStage(stage: StageKey, projectId: string): string {
  switch (stage) {
    case 'highlights_ready':
      return `/projects/${projectId}/highlights`;
    case 'gallery_published':
      return `/projects/${projectId}/gallery`;
    case 'album_selection':
      return `/projects/${projectId}/album-selection`;
    default:
      return `/projects/${projectId}`;
  }
}

function defaultStageMessage(stage: StageKey, projectTitle: string): string {
  switch (stage) {
    case 'booking_confirmed':
      return `Your booking for ${projectTitle} has been confirmed.`;
    case 'deposit_paid':
      return 'Your deposit has been received. Thank you.';
    case 'session_completed':
      return `The photo session for ${projectTitle} is complete.`;
    case 'editing':
      return 'Your photographs are being edited.';
    case 'highlights_ready':
      return 'Your memories are ready to view.';
    case 'gallery_published':
      return 'Your private gallery is now live.';
    case 'album_selection':
      return 'Your album selection has been submitted.';
    case 'final_delivery':
      return 'Your final gallery has been delivered.';
    case 'completed':
      return `${projectTitle} is complete. Thank you for choosing us.`;
    default:
      return '';
  }
}

/**
 * Photographer override. Always recorded as a manual event so the history shows
 * that a human moved the stage, and it may move backwards deliberately.
 */
export async function setStageManually(
  projectId: Types.ObjectId | string,
  stage: StageKey,
  actorId: Types.ObjectId | string,
  reason = '',
): Promise<AdvanceResult> {
  const project = await ProjectModel.findById(projectId);
  if (!project) throw new Error('Project not found.');

  const previous = project.timelineStage ?? 'booking_requested';
  project.timelineStage = stage;
  project.timelineCompletedAt = new Date();
  if (stage === 'completed') project.status = 'completed';
  else if (stage === 'final_delivery') project.status = 'delivered';
  await project.save();

  await TimelineEventModel.create({
    projectId: project._id,
    photographerId: project.photographerId,
    clientId: project.clientId,
    stage,
    title: stageLabel(stage),
    description: reason,
    automatic: false,
    trigger: 'MANUAL',
    previousStage: previous,
    actorId,
  });

  return { moved: true, stage, from: previous, to: stage };
}

export interface TimelineView {
  stages: (typeof STAGES)[number][];
  current: string;
  currentIndex: number;
  completed: boolean;
  percent: number;
  events: {
    id: string;
    stage: string;
    title: string;
    description: string;
    automatic: boolean;
    occurredAt: Date;
    visibleToClient: boolean;
  }[];
}

/** Assembles the client-facing timeline. Manual events are included for the owner only. */
export async function buildTimeline(
  projectId: Types.ObjectId | string,
  options: { includeInternal: boolean },
): Promise<TimelineView> {
  const project = await ProjectModel.findById(projectId).lean();
  if (!project) throw new Error('Project not found.');

  const query: Record<string, unknown> = { projectId: project._id };
  if (!options.includeInternal) query.visibleToClient = true;

  const events = await TimelineEventModel.find(query).sort({ occurredAt: 1, _id: 1 }).lean();

  const current = project.timelineStage ?? 'booking_requested';
  const currentIndex = Math.max(0, STAGE_KEYS.indexOf(current as StageKey));
  const total = STAGES.length;

  return {
    stages: STAGES.map((s) => ({ ...s })),
    current,
    currentIndex,
    completed: current === 'completed',
    percent: Math.round(((currentIndex + 1) / total) * 100),
    events: events.map((e) => ({
      id: String(e._id),
      stage: e.stage,
      title: e.title,
      description: e.description,
      automatic: Boolean(e.automatic),
      occurredAt: e.occurredAt,
      visibleToClient: Boolean(e.visibleToClient),
    })),
  };
}
