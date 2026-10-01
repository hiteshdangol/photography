import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/response.js';
import { AlbumModel, PhotoModel, ProjectModel } from '../models/index.js';
import { authenticate, requirePhotographer } from '../middleware/auth.js';
import { validateBody, validateQuery, q } from '../middleware/validate.js';
import { ApiError } from '../utils/ApiError.js';
import { assertProjectAccess, objectId } from '../services/authorization.js';
import { buildTimeline, setStageManually, stageLabel, STAGE_KEYS, STAGES } from '../services/timeline/engine.js';
import { reconcileProject } from '../services/timeline/reconcile.js';

const router = Router();

/* -------------------------------------------------------------------------- */
/* Listing                                                                     */
/* -------------------------------------------------------------------------- */

const listSchema = z.object({
  status: z.enum(['planning', 'confirmed', 'shooting', 'editing', 'delivered', 'completed', 'cancelled']).optional(),
  search: z.string().trim().max(120).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(60).default(24),
});

/**
 * Project list for both dashboards.
 *
 * The scope comes from the verified role, never from a query parameter: a
 * photographer sees their own projects, a client sees the ones they booked.
 */
router.get(
  '/',
  authenticate,
  validateQuery(listSchema),
  asyncHandler(async (req, res) => {
    const filters = q<z.infer<typeof listSchema>>(req);
    const pagination = {
      page: filters.page,
      limit: filters.limit,
      skip: (filters.page - 1) * filters.limit,
    };

    const filter: Record<string, unknown> =
      req.ctx.role === 'client' ? { clientId: req.ctx.userId } : { photographerId: req.ctx.tenantId };
    if (req.ctx.role === 'superadmin') delete filter.photographerId;
    if (filters.status) filter.status = filters.status;
    if (filters.search) filter.title = { $regex: escapeRegex(filters.search), $options: 'i' };
    if (filters.from || filters.to) {
      filter.eventDate = {
        ...(filters.from ? { $gte: filters.from } : {}),
        ...(filters.to ? { $lte: filters.to } : {}),
      };
    }

    const [items, total, counts] = await Promise.all([
      ProjectModel.find(filter)
        .sort({ eventDate: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit)
        .populate('clientId', 'name email phone avatar')
        .lean(),
      ProjectModel.countDocuments(filter),
      ProjectModel.aggregate([
        { $match: filter },
        { $group: { _id: '$status', count: { $sum: 1 }, valueMinor: { $sum: '$totalMinor' } } },
      ]),
    ]);

    return ok(res, {
      projects: items,
      pagination: {
        ...pagination,
        total,
        totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
      },
      summary: counts.map((c) => ({ status: c._id, count: c.count, valueMinor: c.value })),
    });
  }),
);

/** Everything the dashboard header shows, in one round trip. */
router.get(
  '/summary',
  authenticate,
  asyncHandler(async (req, res) => {
    const scope: Record<string, unknown> =
      req.ctx.role === 'client' ? { clientId: req.ctx.userId } : { photographerId: req.ctx.tenantId };

    const [totals, byStage, upcoming, needsAttention] = await Promise.all([
      ProjectModel.aggregate([
        { $match: scope },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            valueMinor: { $sum: '$totalMinor' },
            active: {
              $sum: { $cond: [{ $in: ['$status', ['planning', 'confirmed', 'shooting', 'editing']] }, 1, 0] },
            },
            delivered: { $sum: { $cond: [{ $in: ['$status', ['delivered', 'completed']] }, 1, 0] } },
          },
        },
      ]),
      ProjectModel.aggregate([{ $match: scope }, { $group: { _id: '$timelineStage', count: { $sum: 1 } } }]),
      ProjectModel.find({
        ...scope,
        eventDate: { $gte: new Date() },
        status: { $nin: ['cancelled', 'completed'] },
      })
        .sort({ eventDate: 1 })
        .limit(5)
        .select('title eventDate status timelineStage location')
        .lean(),
      // Past the event date but not yet delivered: the studio's to-do list.
      ProjectModel.countDocuments({
        ...scope,
        eventDate: { $lt: new Date() },
        status: { $nin: ['delivered', 'completed', 'cancelled'] },
      }),
    ]);

    return ok(res, {
      totals: totals[0] ?? { total: 0, valueMinor: 0, active: 0, delivered: 0 },
      byStage: Object.fromEntries(byStage.map((t) => [t._id, t.count])),
      upcoming,
      needsAttention,
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Single project                                                              */
/* -------------------------------------------------------------------------- */

router.get(
  '/:id',
  authenticate,
  asyncHandler(async (req, res) => {
    const project = await assertProjectAccess(req.params.id, req.ctx, { adminAudit: readReason(req) });

    // Self-heal: if the event date has passed, the timeline catches up here too,
    // so a missed cron tick is invisible to the user.
    await reconcileProject(String(project._id));

    const fresh = await ProjectModel.findById(project._id)
      .populate('clientId', 'name email phone avatar')
      .lean();
    if (!fresh) throw ApiError.notFound('That project does not exist.');

    const [timeline, albums] = await Promise.all([
      buildTimeline(project._id, { includeInternal: req.ctx.role === 'photographer' }),
      AlbumModel.find({ projectId: project._id }).sort({ sortOrder: 1 }).lean(),
    ]);

    return ok(res, { project: fresh, timeline, albums, viewerRole: req.ctx.role });
  }),
);

router.patch(
  '/:id',
  authenticate,
  requirePhotographer,
  validateBody(
    z.object({
      title: z.string().trim().min(2).max(160).optional(),
      description: z.string().trim().max(4000).optional(),
      location: z.string().trim().max(240).optional(),
      status: z.enum(['planning', 'confirmed', 'shooting', 'editing', 'delivered', 'completed', 'cancelled']).optional(),
      coverPhotoId: z.string().optional(),
      allowClientDownloads: z.boolean().optional(),
      allowOriginalDownloads: z.boolean().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const project = await assertProjectAccess(req.params.id, req.ctx);
    if (String(project.photographerId) !== String(req.ctx.tenantId)) {
      throw ApiError.forbidden('Only the owning photographer can edit a project.');
    }

    if (req.body.coverPhotoId) {
      const cover = await PhotoModel.findOne({
        _id: objectId(req.body.coverPhotoId, 'photo id'),
        projectId: project._id,
      })
        .select('_id')
        .lean();
      if (!cover) throw ApiError.badRequest('That photo is not part of this project.');
      project.coverPhotoId = cover._id;
    }

    if (req.body.title !== undefined) project.title = req.body.title;
    if (req.body.description !== undefined) project.description = req.body.description;
    if (req.body.location !== undefined) project.location = req.body.location;
    if (req.body.status !== undefined) project.status = req.body.status;
    if (req.body.allowClientDownloads !== undefined) {
      project.gallery.allowClientDownloads = req.body.allowClientDownloads;
    }
    if (req.body.allowOriginalDownloads !== undefined) {
      // Turning this on is a deliberate photographer decision, so it is allowed -
      // but it stays per-photo too, so enabling it here never leaks a photo that
      // was explicitly protected.
      project.gallery.allowOriginalDownloads = req.body.allowOriginalDownloads;
    }

    await project.save();
    return ok(res, { project }, 'Project updated.');
  }),
);

/* -------------------------------------------------------------------------- */
/* Timeline                                                                    */
/* -------------------------------------------------------------------------- */

router.get(
  '/:id/timeline',
  authenticate,
  asyncHandler(async (req, res) => {
    const project = await assertProjectAccess(req.params.id, req.ctx, { adminAudit: readReason(req) });
    const timeline = await buildTimeline(project._id, { includeInternal: req.ctx.role === 'photographer' });
    return ok(res, timeline);
  }),
);

router.post(
  '/:id/timeline/stage',
  authenticate,
  requirePhotographer,
  validateBody(
    z.object({
      stage: z.enum(STAGE_KEYS as [string, ...string[]]),
      reason: z.string().trim().max(600).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const project = await assertProjectAccess(req.params.id, req.ctx);
    if (String(project.photographerId) !== String(req.ctx.tenantId)) {
      throw ApiError.forbidden('Only the owning photographer can move the timeline.');
    }
    const stage = req.body.stage as (typeof STAGE_KEYS)[number];
    const result = await setStageManually(project._id, stage, req.ctx.userId, req.body.reason ?? '');
    return ok(res, result, `Timeline moved to ${stageLabel(stage)}.`);
  }),
);

/** The stage list is static, so the client renders the progress bar from this. */
router.get(
  '/meta/stages',
  asyncHandler(async (_req, res) => ok(res, { stages: STAGES })),
);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A superadmin reading tenant data must say why; the reason is audited. */
function readReason(req: { query: Record<string, unknown> }): string | undefined {
  const reason = req.query.reason;
  return typeof reason === 'string' && reason.length >= 4 ? reason.slice(0, 600) : undefined;
}

export default router;
