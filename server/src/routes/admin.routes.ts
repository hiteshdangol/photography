import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, noContent } from '../utils/response.js';
import {
  AuditLogModel,
  BookingModel,
  ContactInquiryModel,
  ConversationModel,
  InvoiceModel,
  NotificationModel,
  GalleryShareModel,
  PaymentModel,
  PhotographerProfileModel,
  PhotoModel,
  PlatformSettingsModel,
  ProjectModel,
  RefreshTokenModel,
  TestimonialModel,
  UserModel,
} from '../models/index.js';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';
import { validateBody, validateQuery, q } from '../middleware/validate.js';
import { ApiError } from '../utils/ApiError.js';
import { ADMIN_ERRORS } from '../messages.js';
import { objectId } from '../services/authorization.js';
import { adminAudit } from '../services/admin.service.js';
import { getStorage } from '../services/storage/index.js';

const router = Router();

/**
 * Everything below this line is super-admin only.
 *
 * Applied once on the router rather than repeated per route: a new admin endpoint
 * added later is protected by default, not by remembering to add middleware.
 */
router.use(authenticate, requireSuperAdmin);

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                   */
/* -------------------------------------------------------------------------- */

router.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [
      users,
      photographers,
      clients,
      bookings,
      pendingBookings,
      projects,
      inquiries,
      newInquiries,
      revenueAgg,
      photos,
    ] = await Promise.all([
      UserModel.countDocuments({}),
      UserModel.countDocuments({ role: 'photographer' }),
      UserModel.countDocuments({ role: 'client' }),
      BookingModel.countDocuments({}),
      BookingModel.countDocuments({ status: 'pending' }),
      ProjectModel.countDocuments({}),
      ContactInquiryModel.countDocuments({}),
      ContactInquiryModel.countDocuments({ createdAt: { $gte: weekAgo } }),
      PaymentModel.aggregate([
        { $match: { status: 'completed', paidAt: { $gte: monthAgo } } },
        { $group: { _id: null, total: { $sum: '$amountMinor' }, count: { $sum: 1 } } },
      ]),
      PhotoModel.countDocuments({}),
    ]);

    const usage = await getStorage().usage();

    return ok(res, {
      counts: {
        users,
        photographers,
        clients,
        bookings,
        pendingBookings,
        projects,
        photos,
        inquiries,
        newInquiriesThisWeek: newInquiries,
      },
      revenue: {
        last30DaysMinor: revenueAgg[0]?.total ?? 0,
        transactions: revenueAgg[0]?.count ?? 0,
      },
      storage: {
        bytes: usage.bytes,
        objects: usage.objects,
        note: 'Local disk driver reports everything under the upload root.',
      },
      generatedAt: new Date(),
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Users                                                                       */
/* -------------------------------------------------------------------------- */

const userListSchema = z.object({
  role: z.enum(['superadmin', 'photographer', 'client']).optional(),
  status: z.enum(['active', 'suspended', 'pending_verification']).optional(),
  q: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

router.get(
  '/users',
  validateQuery(userListSchema),
  asyncHandler(async (req, res) => {
    const filters = q<z.infer<typeof userListSchema>>(req);
    const filter: Record<string, unknown> = {};
    if (filters.role) filter.role = filters.role;
    if (filters.status) filter.status = filters.status;
    if (filters.q) {
      // Escaped: an unescaped user-supplied regex would let `.*` match everyone
      // and a malformed pattern would throw a 500.
      const escaped = filters.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [{ name: new RegExp(escaped, 'i') }, { email: new RegExp(escaped, 'i') }];
    }

    const skip = (filters.page - 1) * filters.limit;
    const [items, total] = await Promise.all([
      UserModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(filters.limit).lean(),
      UserModel.countDocuments(filter),
    ]);

    return ok(res, {
      users: items.map((u) => ({
        id: String(u._id),
        name: u.name,
        email: u.email,
        phone: u.phone,
        avatar: u.avatar,
        role: u.role,
        status: u.status,
        emailVerified: Boolean(u.emailVerified),
        lastLoginAt: u.lastLoginAt,
        createdAt: u.createdAt,
      })),
      pagination: {
        page: filters.page,
        limit: filters.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / filters.limit)),
      },
    });
  }),
);

const suspendSchema = z.object({
  status: z.enum(['active', 'suspended']),
  reason: z.string().trim().min(5, 'Give a reason for the audit trail.').max(400),
});

/**
 * Suspend or restore an account.
 *
 * Suspension blocks new access tokens; existing ones keep working until they
 * expire, which is why this also revokes refresh tokens - otherwise "suspended"
 * would mean nothing to a client holding a long-lived refresh cookie.
 *
 * Admins cannot suspend themselves, which removes the one mistake that could
 * lock the platform out of its own backend.
 */
router.patch(
  '/users/:id/status',
  validateBody(suspendSchema),
  asyncHandler(async (req, res) => {
    const user = await UserModel.findById(objectId(req.params.id, 'user id'));
    if (!user) throw ApiError.notFound(ADMIN_ERRORS.noUser);
    if (String(user._id) === String(req.ctx.userId)) {
      throw ApiError.badRequest('You cannot change your own status.');
    }

    const previous = user.status;
    user.status = req.body.status;
    await user.save();

    if (req.body.status === 'suspended') {
      await RefreshTokenModel.deleteMany({ userId: user._id });
      await NotificationModel.deleteMany({ userId: user._id });
    }

    await adminAudit(req, 'user_status_changed', 'user', user._id, {
      reason: req.body.reason,
      metadata: { tenantId: user.role === 'photographer' ? user._id : null, from: previous, to: req.body.status },
    });

    return ok(res, { id: String(user._id), status: user.status }, `Account ${req.body.status}.`);
  }),
);

const verifySchema = z.object({ verified: z.boolean() });

router.patch(
  '/users/:id/verification',
  validateBody(verifySchema),
  asyncHandler(async (req, res) => {
    const profile = await PhotographerProfileModel.findOne({
      userId: objectId(req.params.id, 'user id'),
    });
    if (!profile) throw ApiError.notFound(ADMIN_ERRORS.noPhotographer);

    profile.verification.verified = req.body.verified;
    profile.verification.verifiedAt = req.body.verified ? new Date() : null;
    if (req.body.verified) {
      // The admin has vouched for the studio, so the document upload is moot.
      profile.verification.document = profile.verification.document ?? null;
    }
    await profile.save();

    await adminAudit(req, 'photographer_verification_changed', 'photographerProfile', profile._id, {
      metadata: { tenantId: profile.userId, verified: req.body.verified },
    });

    return ok(
      res,
      { verified: profile.verification.verified, verifiedAt: profile.verification.verifiedAt },
      req.body.verified ? 'Photographer verified.' : 'Verification removed.',
    );
  }),
);

/* -------------------------------------------------------------------------- */
/* Bookings and invoices                                                        */
/* -------------------------------------------------------------------------- */

const bookingListSchema = z.object({
  status: z.string().trim().max(30).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

router.get(
  '/bookings',
  validateQuery(bookingListSchema),
  asyncHandler(async (req, res) => {
    const filters = q<z.infer<typeof bookingListSchema>>(req);
    const filter: Record<string, unknown> = {};
    if (filters.status) filter.status = filters.status;

    const skip = (filters.page - 1) * filters.limit;
    const [items, total] = await Promise.all([
      BookingModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(filters.limit).lean(),
      BookingModel.countDocuments(filter),
    ]);

    return ok(res, {
      bookings: items.map((b) => ({
        id: String(b._id),
        reference: b.reference,
        eventType: b.eventType,
        eventDate: b.eventDate,
        status: b.status,
        paymentStatus: b.paymentStatus,
        totalMinor: b.priceSnapshot.totalMinor,
        currency: b.priceSnapshot.currency,
        photographerId: String(b.photographerId),
        clientId: String(b.clientId),
        createdAt: b.createdAt,
      })),
      pagination: {
        page: filters.page,
        limit: filters.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / filters.limit)),
      },
    });
  }),
);

const voidSchema = z.object({ reason: z.string().trim().min(5).max(400) });

router.post(
  '/invoices/:id/void',
  validateBody(voidSchema),
  asyncHandler(async (req, res) => {
    const invoice = await InvoiceModel.findById(objectId(req.params.id, 'invoice id'));
    if (!invoice) throw ApiError.notFound(ADMIN_ERRORS.noInvoice);
    if (invoice.status === 'void') throw ApiError.conflict('That invoice is already void.');
    if (invoice.paidMinor > 0) throw ApiError.conflict('This invoice has payments against it.');

    invoice.status = 'void';
    await invoice.save();

    await adminAudit(req, 'invoice_voided', 'invoice', invoice._id, {
      reason: req.body.reason,
      metadata: { tenantId: invoice.photographerId, invoiceNumber: invoice.invoiceNumber },
    });

    return ok(res, { id: String(invoice._id), status: 'void' }, 'Invoice voided.');
  }),
);

/* -------------------------------------------------------------------------- */
/* Contact inbox                                                                */
/* -------------------------------------------------------------------------- */

const inquiryListSchema = z.object({
  status: z.enum(['new', 'read', 'replied', 'archived', 'spam']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

router.get(
  '/inquiries',
  validateQuery(inquiryListSchema),
  asyncHandler(async (req, res) => {
    const filters = q<z.infer<typeof inquiryListSchema>>(req);
    const filter: Record<string, unknown> = {};
    if (filters.status) filter.status = filters.status;

    const skip = (filters.page - 1) * filters.limit;
    const [items, total] = await Promise.all([
      ContactInquiryModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(filters.limit).lean(),
      ContactInquiryModel.countDocuments(filter),
    ]);

    return ok(res, {
      inquiries: items.map((inquiry) => ({ ...inquiry, id: String(inquiry._id) })),
      pagination: {
        page: filters.page,
        limit: filters.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / filters.limit)),
      },
    });
  }),
);

router.patch(
  '/inquiries/:id',
  validateBody(
    z.object({
      status: z.enum(['new', 'read', 'replied', 'archived', 'spam']).optional(),
      replyNote: z.string().trim().max(4000).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const inquiry = await ContactInquiryModel.findById(objectId(req.params.id, 'inquiry id'));
    if (!inquiry) throw ApiError.notFound('That inquiry does not exist.');

    if (req.body.status) {
      inquiry.status = req.body.status;
      if (req.body.status === 'read' && !inquiry.readAt) inquiry.readAt = new Date();
      if (req.body.status === 'replied') {
        inquiry.repliedAt = new Date();
        inquiry.repliedBy = req.ctx.userId;
      }
    }
    if (req.body.replyNote !== undefined) inquiry.replyNote = req.body.replyNote;

    await inquiry.save();
    await adminAudit(req, 'inquiry_updated', 'contactInquiry', inquiry._id, {
      metadata: { status: inquiry.status },
    });

    return ok(res, { inquiry }, 'Inquiry updated.');
  }),
);

/* -------------------------------------------------------------------------- */
/* Testimonials moderation                                                      */
/* -------------------------------------------------------------------------- */

const globalTestimonialSchema = z.object({
  approved: z.boolean().optional(),
  featured: z.boolean().optional(),
  reason: z.string().trim().max(400).optional(),
});

router.patch(
  '/testimonials/:id',
  validateBody(globalTestimonialSchema),
  asyncHandler(async (req, res) => {
    const testimonial = await TestimonialModel.findById(objectId(req.params.id, 'testimonial id'));
    if (!testimonial) throw ApiError.notFound('That review does not exist.');

    if (req.body.approved !== undefined) {
      testimonial.approved = req.body.approved;
      testimonial.approvedAt = req.body.approved ? new Date() : null;
    }
    if (req.body.featured !== undefined) testimonial.featured = req.body.featured;
    if (req.body.reason !== undefined) testimonial.rejectedReason = req.body.reason;
    await testimonial.save();

    await adminAudit(req, 'testimonial_moderated', 'testimonial', testimonial._id, {
      reason: req.body.reason,
      metadata: { tenantId: testimonial.photographerId, approved: testimonial.approved },
    });

    return ok(res, { testimonial }, 'Review updated.');
  }),
);

/* -------------------------------------------------------------------------- */
/* Platform settings                                                            */
/* -------------------------------------------------------------------------- */

router.get(
  '/settings',
  asyncHandler(async (_req, res) => {
    const settings = await PlatformSettingsModel.findOneAndUpdate(
      { key: 'default' },
      { $setOnInsert: { key: 'default' } },
      { new: true, upsert: true },
    ).lean();
    return ok(res, { settings });
  }),
);

const settingsSchema = z.object({
  siteName: z.string().trim().min(2).max(80).optional(),
  tagline: z.string().trim().max(160).optional(),
  supportEmail: z.string().email().optional(),
  supportPhone: z.string().trim().max(40).optional(),
  defaultCurrency: z.string().trim().length(3).optional(),
  maintenance: z
    .object({
      enabled: z.boolean().optional(),
      message: z.string().trim().max(300).optional(),
      allowPhotographers: z.boolean().optional(),
      allowRegistrations: z.boolean().optional(),
    })
    .optional(),
  registration: z
    .object({
      requireEmailVerification: z.boolean().optional(),
      defaultClientRole: z.string().trim().max(20).optional(),
    })
    .optional(),
  payments: z
    .object({
      enabled: z.boolean().optional(),
      activeProvider: z.string().trim().max(20).optional(),
      allowedProviders: z.array(z.string().trim().max(20)).max(10).optional(),
      depositEnforced: z.boolean().optional(),
    })
    .optional(),
  features: z
    .object({
      chat: z.boolean().optional(),
      highlights: z.boolean().optional(),
      albumSelection: z.boolean().optional(),
      testimonials: z.boolean().optional(),
      sharing: z.boolean().optional(),
    })
    .optional(),
  social: z
    .object({
      instagram: z.string().trim().max(120).optional(),
      facebook: z.string().trim().max(120).optional(),
      twitter: z.string().trim().max(120).optional(),
      youtube: z.string().trim().max(120).optional(),
    })
    .optional(),
});

router.patch(
  '/settings',
  validateBody(settingsSchema),
  asyncHandler(async (req, res) => {
    const settings = await PlatformSettingsModel.findOneAndUpdate(
      { key: 'default' },
      { $set: req.body, $setOnInsert: { key: 'default' } },
      { new: true, upsert: true },
    ).lean();

    await adminAudit(req, 'platform_settings_updated', 'platformSettings', settings?._id, {
      metadata: { changed: Object.keys(req.body) },
    });

    return ok(res, { settings }, 'Settings saved.');
  }),
);

/* -------------------------------------------------------------------------- */
/* Audit trail                                                                  */
/* -------------------------------------------------------------------------- */

const auditSchema = z.object({
  actorId: z.string().optional(),
  action: z.string().trim().max(60).optional(),
  targetType: z.string().trim().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

router.get(
  '/audit',
  validateQuery(auditSchema),
  asyncHandler(async (req, res) => {
    const filters = q<z.infer<typeof auditSchema>>(req);
    const filter: Record<string, unknown> = {};
    if (filters.actorId) filter.actorId = objectId(filters.actorId, 'actor id');
    if (filters.action) filter.action = filters.action;
    if (filters.targetType) filter.targetType = filters.targetType;

    const skip = (filters.page - 1) * filters.limit;
    const [items, total] = await Promise.all([
      AuditLogModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(filters.limit).lean(),
      AuditLogModel.countDocuments(filter),
    ]);

    return ok(res, {
      entries: items.map((entry) => ({
        id: String(entry._id),
        actorId: String(entry.actorId),
        actorRole: entry.actorRole,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId ? String(entry.targetId) : null,
        tenantId: entry.tenantId ? String(entry.tenantId) : null,
        reason: entry.reason,
        ip: entry.ip,
        createdAt: entry.createdAt,
      })),
      pagination: {
        page: filters.page,
        limit: filters.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / filters.limit)),
      },
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Maintenance                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Data-integrity sweep.
 *
 * Read-only: it reports counters that disagree with reality (e.g. a project whose
 * stored photo count does not match its actual photos) rather than "fixing" them,
 * because a silent mass update is exactly the kind of thing that destroys data
 * when the diagnosis is wrong.
 */
router.get(
  '/integrity',
  asyncHandler(async (_req, res) => {
    const [photoCount, distinctProjects, orphanPhotos, emptyProjects, danglingConversations] =
      await Promise.all([
        PhotoModel.countDocuments({}),
        PhotoModel.distinct('projectId'),
        PhotoModel.countDocuments({ projectId: { $in: [] } }),
        ProjectModel.countDocuments({ 'counts.photos': { $gt: 0 } }),
        ConversationModel.countDocuments({ messageCount: { $gt: 0 }, lastMessageAt: null }),
      ]);

    const driftedProjects = await ProjectModel.aggregate([
      {
        $lookup: {
          from: 'photos',
          localField: '_id',
          foreignField: 'projectId',
          as: 'photoDocs',
        },
      },
      {
        $match: {
          $expr: { $ne: [{ $ifNull: ['$counts.photos', 0] }, { $size: '$photoDocs' }] },
        },
      },
      { $project: { title: 1, stored: '$counts.photos', actual: { $size: '$photoDocs' } } },
      { $limit: 50 },
    ]);

    return ok(res, {
      photos: photoCount,
      projectsWithPhotos: distinctProjects.length,
      emptyProjects: emptyProjects,
      orphanPhotos,
      danglingConversations,
      driftedProjectCounts: driftedProjects,
      checkedAt: new Date(),
    });
  }),
);

/** Clear expired tokens and read notifications. Admin-only, audited. */
router.post(
  '/maintenance/cleanup',
  validateBody(z.object({ reason: z.string().trim().min(5).max(300) })),
  asyncHandler(async (req, res) => {
    const [tokens, notifications, shares] = await Promise.all([
      RefreshTokenModel.deleteMany({ expiresAt: { $lt: new Date() } }),
      NotificationModel.deleteMany({
        read: true,
        createdAt: { $lt: new Date(Date.now() - 90 * 24 * 3600 * 1000) },
      }),
      GalleryShareModel.deleteMany({
        revokedAt: { $ne: null, $lt: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
      }),
    ]);

    await adminAudit(req, 'maintenance_cleanup', 'platform', null, {
      reason: req.body.reason,
      metadata: { tokens: tokens.deletedCount, notifications: notifications.deletedCount, shares: shares.deletedCount },
    });

    return ok(
      res,
      {
        removedTokens: tokens.deletedCount,
        removedNotifications: notifications.deletedCount,
        removedShares: shares.deletedCount,
      },
      'Cleanup complete.',
    );
  }),
);

router.delete(
  '/notifications/:id',
  asyncHandler(async (req, res) => {
    const result = await NotificationModel.deleteOne({ _id: objectId(req.params.id, 'notification id') });
    if (result.deletedCount === 0) throw ApiError.notFound('That notification does not exist.');
    await adminAudit(req, 'notification_deleted', 'notification', req.params.id, {});
    return noContent(res, 'Notification removed.');
  }),
);

export default router;
