import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/response.js';
import { authenticate, optionalAuthenticate, requirePhotographer } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { ApiError } from '../utils/ApiError.js';
import { AvailabilityBlockModel, AvailabilityRuleModel } from '../models/index.js';
import { assertTenantOwner, objectId } from '../services/authorization.js';
import { dayAvailability, rangeAvailability } from '../services/availability.js';
import { directoryLimiter } from '../middleware/rateLimit.js';

const router = Router();

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

const ruleSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  windows: z
    .array(z.object({ start: z.string().regex(timePattern), end: z.string().regex(timePattern) }))
    .max(6),
  active: z.boolean().optional(),
});

const blockSchema = z.object({
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  allDay: z.boolean().default(true),
  windows: z
    .array(z.object({ start: z.string().regex(timePattern), end: z.string().regex(timePattern) }))
    .max(6)
    .default([]),
  reason: z.string().trim().max(200).optional(),
});

/** The photographer's own schedule. */
router.get(
  '/mine',
  authenticate,
  requirePhotographer,
  asyncHandler(async (req, res) => {
    const [rules, blocks] = await Promise.all([
      AvailabilityRuleModel.find({ photographerId: req.ctx.tenantId }).sort({ dayOfWeek: 1 }).lean(),
      AvailabilityBlockModel.find({ photographerId: req.ctx.tenantId })
        .sort({ startDate: 1 })
        .limit(200)
        .lean(),
    ]);
    return ok(res, { rules, blocks });
  }),
);

router.put(
  '/rules/:dayOfWeek',
  authenticate,
  requirePhotographer,
  validateBody(ruleSchema.omit({ dayOfWeek: true })),
  asyncHandler(async (req, res) => {
    const dayOfWeek = Number(req.params.dayOfWeek);
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
      throw ApiError.badRequest('Invalid day of week.');
    }
    for (const window of req.body.windows ?? []) {
      if (window.end <= window.start) {
        throw ApiError.validation('Please check the highlighted fields.', [
          { field: 'windows', message: 'Each window must end after it starts.' },
        ]);
      }
    }

    const rule = await AvailabilityRuleModel.findOneAndUpdate(
      { photographerId: req.ctx.tenantId, dayOfWeek },
      { $set: { ...req.body, active: req.body.active ?? true } },
      { new: true, upsert: true, runValidators: true },
    );
    return ok(res, { rule }, 'Working hours saved.');
  }),
);

router.post(
  '/blocks',
  authenticate,
  requirePhotographer,
  validateBody(blockSchema),
  asyncHandler(async (req, res) => {
    if (req.body.endDate.getTime() < req.body.startDate.getTime()) {
      throw ApiError.validation('Please check the highlighted fields.', [
        { field: 'endDate', message: 'The end date must be on or after the start date.' },
      ]);
    }
    const block = await AvailabilityBlockModel.create({ ...req.body, photographerId: req.ctx.tenantId });
    return res.status(201).json({ success: true, message: 'Date blocked.', data: { block } });
  }),
);

router.delete(
  '/blocks/:id',
  authenticate,
  requirePhotographer,
  asyncHandler(async (req, res) => {
    const block = await AvailabilityBlockModel.findById(req.params.id);
    if (!block) throw ApiError.notFound('Block not found.');
    assertTenantOwner(req.ctx, block.photographerId);
    await block.deleteOne();
    return ok(res, { deleted: true }, 'Date unblocked.');
  }),
);

/**
 * Public per-day availability for the booking calendar. The booking form uses
 * this to show real slots; the server re-checks on submit regardless.
 */
router.get(
  '/:photographerId',
  directoryLimiter,
  optionalAuthenticate,
  asyncHandler(async (req, res) => {
    const photographerId = objectId(req.params.photographerId, 'photographer id');
    const { from, to, date } = z
      .object({
        date: z.coerce.date().optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
      })
      .parse(req.query);

    if (date) {
      return ok(res, { days: [await dayAvailability(photographerId, date)] });
    }

    const start = from ?? new Date();
    const end = to ?? new Date(start.getTime() + 90 * 24 * 60 * 60 * 1000);
    return ok(res, { days: await rangeAvailability(photographerId, start, end) });
  }),
);

export default router;
