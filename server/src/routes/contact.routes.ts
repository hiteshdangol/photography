import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/response.js';
import { ContactInquiryModel } from '../models/ContactInquiry.js';
import { validateBody } from '../middleware/validate.js';
import { publicFormLimiter } from '../middleware/rateLimit.js';
import { authenticate, requirePhotographer, requireSuperAdmin } from '../middleware/auth.js';
import { ApiError } from '../utils/ApiError.js';
import { notify } from '../services/notifications/dispatcher.js';
import { parsePagination, paginated } from '../utils/pagination.js';
import { adminAudit } from '../services/admin.service.js';

const router = Router();

const inquirySchema = z.object({
  name: z.string().trim().min(2, 'Tell us your name.').max(100),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(160),
  phone: z.string().trim().max(30).optional(),
  subject: z.string().trim().min(3, 'Add a subject.').max(200),
  message: z.string().trim().min(10, 'Please write a little more.').max(4000),
  // Honeypot: bots fill hidden fields, humans never see this one.
  website: z.string().max(0).optional(),
});

/** Public contact form. */
router.post(
  '/',
  publicFormLimiter,
  validateBody(inquirySchema),
  asyncHandler(async (req, res) => {
    // Silently accept honeypot hits so the bot gets no signal.
    if (req.body.website) {
      return ok(res, { received: true }, 'Thanks. We will be in touch.');
    }
    const { website, ...data } = req.body;
    const inquiry = await ContactInquiryModel.create({
      ...data,
      ip: req.ip ?? '',
      source: 'website',
    });

    // Notify the platform owner. A real deployment would route this to a mailbox.
    const { UserModel } = await import('../models/User.js');
    const admins = await UserModel.find({ role: 'superadmin', status: 'active' }).select('_id').lean();
    for (const admin of admins) {
      void notify({
        userId: admin._id,
        type: 'system',
        title: 'New contact inquiry',
        message: `${data.name} <${data.email}> - ${data.subject}`,
        link: '/admin/inquiries',
      });
    }

    return res.status(201).json({
      success: true,
      message: 'Thanks. We will be in touch within one business day.',
      data: { inquiry: { id: String(inquiry._id) } },
    });
  }),
);

const listSchema = z.object({
  status: z.enum(['new', 'read', 'replied', 'archived', 'spam']).optional(),
  photographerId: z.string().optional(),
  page: z.string().optional(),
  limit: z.string().optional(),
});

/**
 * Inbox. A photographer sees only inquiries addressed to them; the superadmin
 * sees everything. There is deliberately no route that lets a photographer read
 * another tenant's inquiries.
 */
router.get(
  '/',
  authenticate,
  requirePhotographer,
  asyncHandler(async (req, res) => {
    const { status, page, limit } = listSchema.parse(req.query) as z.infer<typeof listSchema>;
    const pagination = parsePagination({ page, limit } as never);

    const filter: Record<string, unknown> = { photographerId: req.ctx.tenantId };
    if (status) filter.status = status;

    const [items, total] = await Promise.all([
      ContactInquiryModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit)
        .lean(),
      ContactInquiryModel.countDocuments(filter),
    ]);

    return ok(res, paginated(items, total, pagination));
  }),
);

router.get(
  '/all',
  authenticate,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const { status, page, limit } = listSchema.parse(req.query) as z.infer<typeof listSchema>;
    const pagination = parsePagination({ page, limit } as never);
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;

    const [items, total] = await Promise.all([
      ContactInquiryModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit)
        .lean(),
      ContactInquiryModel.countDocuments(filter),
    ]);
    return ok(res, paginated(items, total, pagination));
  }),
);

const replySchema = z.object({
  replyNote: z.string().trim().max(4000).optional(),
  status: z.enum(['read', 'replied', 'archived', 'spam']).default('replied'),
});

router.patch(
  '/:id',
  authenticate,
  asyncHandler(async (req, res) => {
    const inquiry = await ContactInquiryModel.findById(req.params.id);
    if (!inquiry) throw ApiError.notFound('Inquiry not found.');

    if (req.ctx.role === 'photographer') {
      if (String(inquiry.photographerId) !== String(req.ctx.tenantId)) {
        throw ApiError.notFound('Inquiry not found.');
      }
    } else if (req.ctx.role !== 'superadmin') {
      throw ApiError.forbidden();
    } else {
      await adminAudit(req, 'inquiry.update', 'ContactInquiry', inquiry._id, {
        metadata: { tenantId: inquiry.photographerId },
      });
    }

    const { replyNote, status } = replySchema.parse(req.body);
    inquiry.status = status;
    if (replyNote) {
      inquiry.replyNote = replyNote;
      inquiry.repliedAt = new Date();
      inquiry.repliedBy = req.ctx.userId;
    }
    if (status === 'read' && !inquiry.readAt) inquiry.readAt = new Date();
    await inquiry.save();

    return ok(res, { inquiry }, 'Inquiry updated.');
  }),
);

export default router;
