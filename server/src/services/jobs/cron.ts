import {
  BookingModel,
  GalleryShareModel,
  InvoiceModel,
  NotificationModel,
  PhotographerProfileModel,
  PaymentModel,
  ProjectModel,
} from '../../models/index.js';
import { reconcileOverdueSessions } from '../timeline/reconcile.js';
import { notify, pruneNotifications } from '../notifications/dispatcher.js';
import { env } from '../../config/env.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('cron');

/**
 * Scheduled housekeeping.
 *
 * Every job is idempotent and individually wrapped, so one failing job cannot
 * stop the others and a missed tick (server asleep, redeployed) self-heals on the
 * next run rather than needing a backfill.
 */

interface Job {
  name: string;
  everyMs: number;
  /** Run shortly after boot, so a fresh deployment catches up immediately. */
  runOnStart: boolean;
  handler: () => Promise<unknown>;
}

/** Event date has passed -> "Photo Session Completed". */
async function reconcileSessions(): Promise<number> {
  return reconcileOverdueSessions();
}

/**
 * Safety net: an approved booking should always have a project. If one is
 * missing, it is logged loudly rather than silently patching, because the only
 * known cause is a bug we want to see.
 */
async function findOrphanedApprovals(): Promise<number> {
  const bookings = await BookingModel.find({ status: 'approved' })
    .select('_id')
    .lean();
  const bookingIds = bookings.map((b) => b._id);
  const projects = await ProjectModel.find({ bookingId: { $in: bookingIds } })
    .select('bookingId')
    .lean();
  const projectBookingIds = new Set(projects.map((p) => String(p.bookingId)));
  const orphans = bookings.filter((b) => !projectBookingIds.has(String(b._id)));
  if (orphans.length) {
    log.error('approved bookings without a project', {
      count: orphans.length,
      bookingIds: orphans.slice(0, 10).map((b) => String(b._id)),
    });
  }
  return orphans.length;
}

/** Nudge photographers' clients about sessions coming up. */
async function sendSessionReminders(): Promise<number> {
  const profiles = await PhotographerProfileModel.find()
    .select('userId settings.reminderDaysBefore')
    .lean();

  let sent = 0;
  for (const profile of profiles) {
    const daysBefore = profile.settings?.reminderDaysBefore ?? 3;
    // UTC midnight of the day `daysBefore` from now.
    const target = new Date();
    target.setUTCHours(0, 0, 0, 0);
    target.setUTCDate(target.getUTCDate() + daysBefore);
    const windowEnd = new Date(target.getTime() + 24 * 60 * 60 * 1000);

    const bookings = await BookingModel.find({
      photographerId: profile.userId,
      status: 'approved',
      eventDate: { $gte: target, $lt: windowEnd },
    })
      .select('_id clientId eventType eventDate')
      .lean();

    for (const booking of bookings) {
      // The reminder is per-day, so a 12h lookback is enough to make this idempotent.
      const already = await NotificationModel.exists({
        userId: booking.clientId,
        bookingId: booking._id,
        type: 'booking_reminder',
        createdAt: { $gte: new Date(target.getTime() - 12 * 60 * 60 * 1000) },
      });
      if (already) continue;

      await notify({
        userId: booking.clientId,
        photographerId: profile.userId,
        type: 'booking_reminder',
        title: 'Your shoot is coming up',
        message: `A reminder that your ${booking.eventType} is scheduled for ${booking.eventDate.toDateString()}.`,
        link: '/dashboard/bookings',
        bookingId: booking._id,
        email: true,
      });
      sent += 1;
    }
  }
  return sent;
}

/** Warn clients about invoices that are due soon or already late. */
async function chaseOverdueInvoices(): Promise<number> {
  const due = await InvoiceModel.find({
    status: { $in: ['unpaid', 'partially_paid'] },
    remainingMinor: { $gt: 0 },
    dueDate: { $ne: null, $lte: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) },
  })
    .select('_id clientId photographerId invoiceNumber remainingMinor dueDate')
    .lean();

  let sent = 0;
  for (const invoice of due) {
    // At most one reminder per 20 hours.
    const already = await NotificationModel.exists({
      userId: invoice.clientId,
      invoiceId: invoice._id,
      type: 'payment_reminder',
      createdAt: { $gte: new Date(Date.now() - 20 * 60 * 60 * 1000) },
    });
    if (already) continue;

    const overdue = (invoice.dueDate?.getTime() ?? 0) < Date.now();
    await notify({
      userId: invoice.clientId,
      photographerId: invoice.photographerId,
      type: 'payment_reminder',
      title: overdue ? 'Invoice overdue' : 'Invoice due soon',
      message: `${invoice.invoiceNumber} has ${(invoice.remainingMinor / 100).toFixed(2)} outstanding.`,
      link: `/invoices/${String(invoice._id)}`,
      invoiceId: invoice._id,
      email: true,
    });
    sent += 1;
  }
  return sent;
}

/** Warn about gallery links that are about to expire or already have. */
async function expireShareLinks(): Promise<number> {
  const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  const links = await GalleryShareModel.find({ active: true, expiresAt: { $ne: null, $lte: soon } })
    .select('_id projectId photographerId clientId expiresAt')
    .lean();

  let notified = 0;
  for (const link of links) {
    if (!link.clientId) continue;
    const already = await NotificationModel.exists({
      userId: link.clientId,
      projectId: link.projectId,
      type: 'gallery_link_expiring',
      createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });
    if (already) continue;

    const expired = (link.expiresAt?.getTime() ?? 0) < Date.now();
    await notify({
      userId: link.clientId,
      photographerId: link.photographerId,
      type: 'gallery_link_expiring',
      title: expired ? 'Your gallery link has expired' : 'Your gallery link expires soon',
      message: expired
        ? 'Ask your photographer for a fresh link to view your gallery.'
        : 'Your private gallery link expires in less than two days.',
      link: `/projects/${String(link.projectId)}/gallery`,
      projectId: link.projectId,
      email: true,
    });
    notified += 1;
  }
  return notified;
}

/** Sweep expired payment sessions so they stop showing as "in progress". */
async function expireStalePayments(): Promise<number> {
  const result = await PaymentModel.updateMany(
    { status: 'pending', sessionExpiresAt: { $ne: null, $lt: new Date() } },
    { $set: { status: 'expired' } },
  );
  return result.modifiedCount ?? 0;
}

/** Retention: drop old notifications and retire long-dead share links. */
async function pruneOldRecords(): Promise<{ notifications: number; links: number }> {
  const cutoff = new Date(Date.now() - env.NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const [notifications, links] = await Promise.all([
    pruneNotifications(),
    GalleryShareModel.updateMany(
      { active: true, expiresAt: { $ne: null, $lt: cutoff } },
      { $set: { active: false, revokedAt: new Date() } },
    ),
  ]);
  return { notifications, links: links.modifiedCount ?? 0 };
}

/* -------------------------------------------------------------------------- */
/* Scheduler                                                                   */
/* -------------------------------------------------------------------------- */

const jobs: Job[] = [
  { name: 'reconcile-sessions', everyMs: 30 * 60 * 1000, runOnStart: true, handler: reconcileSessions },
  { name: 'orphan-check', everyMs: 6 * 60 * 60 * 1000, runOnStart: true, handler: findOrphanedApprovals },
  { name: 'session-reminders', everyMs: 6 * 60 * 60 * 1000, runOnStart: false, handler: sendSessionReminders },
  { name: 'invoice-chase', everyMs: 12 * 60 * 60 * 1000, runOnStart: false, handler: chaseOverdueInvoices },
  { name: 'share-link-expiry', everyMs: 12 * 60 * 60 * 1000, runOnStart: false, handler: expireShareLinks },
  { name: 'expire-payments', everyMs: 15 * 60 * 1000, runOnStart: false, handler: expireStalePayments },
  { name: 'prune', everyMs: 24 * 60 * 60 * 1000, runOnStart: false, handler: pruneOldRecords },
];

const timers = new Map<string, NodeJS.Timeout>();
const running = new Set<string>();

async function runJob(job: Job): Promise<unknown> {
  // Never let two ticks of the same job overlap.
  if (running.has(job.name)) {
    log.debug('job skipped, still running', { job: job.name });
    return 'skipped';
  }
  running.add(job.name);
  const startedAt = Date.now();
  try {
    const result = await job.handler();
    log.info('job finished', { job: job.name, ms: Date.now() - startedAt, result });
    return result;
  } catch (error) {
    // A failing job is logged and left to the next tick; it must never take the
    // process down.
    log.error('job failed', {
      job: job.name,
      detail: error instanceof Error ? error.message : String(error),
    });
    return 'failed';
  } finally {
    running.delete(job.name);
  }
}

export function startCron(): void {
  if (timers.size > 0) return;

  for (const job of jobs) {
    if (job.runOnStart) {
      // Deliberately not awaited: the server must not block on housekeeping.
      setTimeout(() => void runJob(job), 5_000).unref();
    }
    const timer = setInterval(() => void runJob(job), job.everyMs);
    // Timers must not keep the process alive during shutdown.
    timer.unref();
    timers.set(job.name, timer);
  }

  log.info('cron started', { jobs: jobs.map((j) => j.name) });
}

export function stopCron(): void {
  for (const timer of timers.values()) clearInterval(timer);
  timers.clear();
  log.info('cron stopped');
}

/** Runs a single job immediately. Used by the test suite and the admin panel. */
export async function runJobNow(name: string): Promise<unknown> {
  const job = jobs.find((j) => j.name === name);
  if (!job) throw new Error(`Unknown job: ${name}`);
  return runJob(job);
}

export function listJobs(): { name: string; everyMs: number }[] {
  return jobs.map((j) => ({ name: j.name, everyMs: j.everyMs }));
}
