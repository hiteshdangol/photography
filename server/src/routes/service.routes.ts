import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created } from '../utils/response.js';
import { ServiceModel } from '../models/index.js';
import { authenticate, optionalAuthenticate, requirePhotographer } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { ApiError } from '../utils/ApiError.js';
import { uniqueSlug } from '../utils/slug.js';
import { assertTenantOwner, objectId, tenantFilter } from '../services/authorization.js';
import { refreshStartingPrice } from '../services/pricing.js';

const router = Router();

const serviceSchema = z.object({
  title: z.string().trim().min(2, 'Give the service a name.').max(120),
  description: z.string().trim().max(2000).optional(),
  categoryKey: z.string().trim().max(40).optional(),
  durationHours: z.number().min(0).max(24).nullable().optional(),
  basePrice: z.number().min(0).optional(),
  deliverables: z.array(z.string().trim().max(120)).max(30).optional(),
  active: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

/** Public list for a photographer profile. */
router.get(
  '/photographer/:photographerId',
  optionalAuthenticate,
  asyncHandler(async (req, res) => {
    const photographerId = objectId(req.params.photographerId, 'photographer id');
    const services = await ServiceModel.find({ photographerId, active: true })
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();
    return ok(res, { services });
  }),
);

router.get(
  '/mine',
  authenticate,
  requirePhotographer,
  asyncHandler(async (req, res) => {
    const services = await ServiceModel.find(tenantFilter(req.ctx)).sort({ sortOrder: 1 }).lean();
    return ok(res, { services });
  }),
);

router.post(
  '/',
  authenticate,
  requirePhotographer,
  validateBody(serviceSchema),
  asyncHandler(async (req, res) => {
    const photographerId = req.ctx.tenantId!;
    const slug = await uniqueSlug(req.body.title, async (candidate) =>
      Boolean(await ServiceModel.findOne({ photographerId, slug: candidate }).select('_id').lean()),
    );
    const service = await ServiceModel.create({ ...req.body, photographerId, slug });
    await refreshStartingPrice(photographerId);
    return created(res, { service }, 'Service created.');
  }),
);

router.patch(
  '/:id',
  authenticate,
  requirePhotographer,
  validateBody(serviceSchema.partial()),
  asyncHandler(async (req, res) => {
    const service = await ServiceModel.findById(req.params.id);
    if (!service) throw ApiError.notFound('Service not found.');
    assertTenantOwner(req.ctx, service.photographerId);
    Object.assign(service, req.body);
    await service.save();
    await refreshStartingPrice(req.ctx.tenantId!);
    return ok(res, { service }, 'Service updated.');
  }),
);

router.delete(
  '/:id',
  authenticate,
  requirePhotographer,
  asyncHandler(async (req, res) => {
    const service = await ServiceModel.findById(req.params.id);
    if (!service) throw ApiError.notFound('Service not found.');
    assertTenantOwner(req.ctx, service.photographerId);
    await service.deleteOne();
    await refreshStartingPrice(req.ctx.tenantId!);
    return ok(res, { deleted: true }, 'Service removed.');
  }),
);

export default router;
