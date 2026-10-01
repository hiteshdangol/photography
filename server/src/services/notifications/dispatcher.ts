import type { Types } from 'mongoose';
import { NotificationModel } from '../../models/Notification.js';
import { UserModel } from '../../models/User.js';
import type { NotificationType } from '../../config/constants.js';
import { sendMail } from './email.service.js';
import { createLogger } from '../../utils/logger.js';
import { env } from '../../config/env.js';

const log = createLogger('notify');

export interface NotifyInput {
  userId: Types.ObjectId | string;
  type: NotificationType;
  title: string;
  message?: string;
  link?: string;
  photographerId?: Types.ObjectId | null;
  bookingId?: Types.ObjectId | null;
  projectId?: Types.ObjectId | null;
  paymentId?: Types.ObjectId | null;
  invoiceId?: Types.ObjectId | null;
  priority?: 'low' | 'normal' | 'high';
  /** Also send an email. Used for money and share-link events. */
  email?: boolean;
}

/**
 * Creates the in-app notification, then fires the email channel.
 *
 * The in-app row is always created even if email delivery fails - a client must
 * never lose a "your gallery is ready" notice because SMTP was down. Email
 * delivery state is recorded on the row itself.
 */
export async function notify(input: NotifyInput): Promise<{ id: string; emailed: boolean }> {
  try {
    const doc = await NotificationModel.create({
      userId: input.userId,
      photographerId: input.photographerId ?? null,
      type: input.type,
      title: input.title,
      message: input.message ?? '',
      link: input.link ?? '',
      bookingId: input.bookingId ?? null,
      projectId: input.projectId ?? null,
      paymentId: input.paymentId ?? null,
      invoiceId: input.invoiceId ?? null,
      priority: input.priority ?? 'normal',
    });

    // Real-time push, if the user has a live socket.
    const { emitToUser } = await import('../../sockets/emitter.js');
    emitToUser(String(input.userId), 'notification:new', {
      id: String(doc._id),
      type: doc.type,
      title: doc.title,
      message: doc.message,
      link: doc.link,
      createdAt: doc.createdAt,
    });

    let emailed = false;
    if (input.email) {
      const user = await UserModel.findById(input.userId).select('email name').lean();
      if (user?.email) {
        const result = await sendMail({
          to: user.email,
          subject: input.title,
          text: `${input.title}\n\n${input.message ?? ''}\n\n${env.CLIENT_URL}${input.link ?? ''}`,
        });
        emailed = result.delivered;
        doc.email.sent = result.delivered;
        doc.email.sentAt = result.delivered ? new Date() : null;
        if (!result.delivered) {
          doc.email.failedAt = new Date();
          doc.email.error = result.error ?? 'unknown';
        }
        await doc.save();
      }
    }

    return { id: String(doc._id), emailed };
  } catch (error) {
    // A notification failure must never roll back the business action that
    // triggered it, so this is logged and swallowed.
    log.error('failed to create notification', {
      type: input.type,
      userId: String(input.userId),
      detail: error instanceof Error ? error.message : String(error),
    });
    return { id: '', emailed: false };
  }
}

export async function notifyMany(userIds: (Types.ObjectId | string)[], input: Omit<NotifyInput, 'userId'>): Promise<void> {
  await Promise.all(userIds.map((userId) => notify({ ...input, userId })));
}

/** Housekeeping: drop notifications past the retention window. */
export async function pruneNotifications(): Promise<number> {
  const cutoff = new Date(Date.now() - env.NOTIFICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const result = await NotificationModel.deleteMany({ createdAt: { $lt: cutoff } });
  return result.deletedCount ?? 0;
}
