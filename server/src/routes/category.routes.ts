import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok } from '../utils/response.js';
import { CategoryModel } from '../models/Category.js';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { ApiError } from '../utils/ApiError.js';
import { z } from 'zod';
import { DEFAULT_CATEGORIES } from '../config/categories.js';
import { adminAudit } from '../services/admin.service.js';

const router = Router();

/** Public: the filter chips on the photographer directory. */
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const categories = await CategoryModel.find({ active: true }).sort({ sortOrder: 1, label: 1 }).lean();
    // Self-heal on an empty collection so a fresh install has no dead filter UI.
    if (categories.length === 0) {
      await CategoryModel.insertMany(DEFAULT_CATEGORIES.map((c) => ({ ...c, active: true })));
    }
    const fresh = categories.length === 0
      ? await CategoryModel.find({ active: true }).sort({ sortOrder: 1 }).lean()
      : categories;
    return ok(res, { categories: fresh });
  }),
);

const createSchema = z.object({
  key: z.string().trim().toLowerCase().min(2).max(40).regex(/^[a-z0-9_]+$/, 'Use letters, numbers and underscores.'),
  label: z.string().trim().min(2).max(60),
  description: z.string().trim().max(400).optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
  featured: z.boolean().optional(),
  active: z.boolean().optional(),
});

router.post(
  '/',
  authenticate,
  requireSuperAdmin,
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const existing = await CategoryModel.findOne({ key: req.body.key }).lean();
    if (existing) throw ApiError.conflict('That category already exists.');
    const category = await CategoryModel.create(req.body);
    await adminAudit(req, 'category.create', 'Category', (category as unknown as { _id: string })._id);
    return res.status(201).json({ success: true, message: 'Category created.', data: { category } });
  }),
);

const updateSchema = createSchema.partial().omit({ key: true });

router.patch(
  '/:id',
  authenticate,
  requireSuperAdmin,
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    const category = await CategoryModel.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!category) throw ApiError.notFound('Category not found.');
    await adminAudit(req, 'category.update', 'Category', category._id);
    return ok(res, { category }, 'Category updated.');
  }),
);

router.delete(
  '/:id',
  authenticate,
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const category = await CategoryModel.findByIdAndDelete(req.params.id);
    if (!category) throw ApiError.notFound('Category not found.');
    await adminAudit(req, 'category.delete', 'Category', category._id);
    return ok(res, { deleted: true }, 'Category deleted.');
  }),
);

export default router;
