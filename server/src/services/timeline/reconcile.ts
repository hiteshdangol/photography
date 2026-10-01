import { ProjectModel } from '../../models/index.js';
import { advance } from './engine.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('timeline:reconcile');

/**
 * Self-healing reconciliation.
 *
 * The spec expects "when the event date passes -> Photo Session Completed"
 * without anyone clicking anything. Relying purely on a cron tick would leave
 * the timeline wrong for up to an hour, so this also runs opportunistically
 * whenever a project is read. It is idempotent, so running it often is free.
 */
export async function reconcileProject(projectId: string): Promise<void> {
  try {
    const project = await ProjectModel.findById(projectId).lean();
    if (!project) return;
    if (!['planning', 'confirmed', 'shooting', 'editing'].includes(project.status)) return;
    if (project.eventDate.getTime() > Date.now()) return;

    await advance({ projectId: project._id, trigger: 'EVENT_DATE_REACHED', silent: false });
  } catch (error) {
    log.warn('reconcile failed', {
      projectId,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Sweep used by the cron worker. */
export async function reconcileOverdueSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - 12 * 60 * 60 * 1000);
  const projects = await ProjectModel.find({
    eventDate: { $lte: cutoff },
    status: { $in: ['planning', 'confirmed'] },
    timelineStage: { $nin: ['session_completed', 'editing', 'highlights_ready', 'gallery_published', 'album_selection', 'final_delivery', 'completed'] },
  })
    .select('_id')
    .lean();

  for (const project of projects) {
    await reconcileProject(String(project._id));
  }
  if (projects.length) log.info('reconciled overdue sessions', { count: projects.length });
  return projects.length;
}
