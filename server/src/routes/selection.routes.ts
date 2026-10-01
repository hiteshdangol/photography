import { Router } from 'express';
import { z } from 'zod';
import type { Types } from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created, noContent } from '../utils/response.js';
import { AlbumModel, PhotoModel, PhotoSelectionModel } from '../models/index.js';
import { authenticate, requireClient, requirePhotographer } from '../middleware/auth.js';
import { validateBody, validateQuery, q } from '../middleware/validate.js';
import { ApiError } from '../utils/ApiError.js';
import { ALBUM_ERRORS } from '../messages.js';
import { assertAlbumAccess, objectId } from '../services/authorization.js';
import { refreshProjectCounts } from '../services/counts.js';
import { advance } from '../services/timeline/engine.js';
import { notify } from '../services/notifications/dispatcher.js';

const router = Router();

/* -------------------------------------------------------------------------- */
/* Client: choosing photos for an album                                        */
/* -------------------------------------------------------------------------- */

const byAlbumSchema = z.object({ albumId: z.string().min(1, 'An album is required.') });

/**
 * The client's current selection for one album, with the remaining allowance.
 * The limit is always reported server-side so the UI cannot drift from the truth.
 */
router.get(
  '/',
  authenticate,
  requireClient,
  validateQuery(byAlbumSchema),
  asyncHandler(async (req, res) => {
    const { albumId } = q<z.infer<typeof byAlbumSchema>>(req);
    const album = await assertAlbumAccess(albumId, req.ctx);
    if (String(album.clientId) !== String(req.ctx.userId)) {
      throw ApiError.notFound('That album does not exist.');
    }
    if (album.status !== 'selection_open') {
      throw ApiError.conflict(
        album.status === 'selection_complete' || album.status === 'final'
          ? ALBUM_ERRORS.completed
          : ALBUM_ERRORS.notOpen,
      );
    }

    const selections = await PhotoSelectionModel.find({
      albumId: album._id,
      clientId: req.ctx.userId,
    })
      .sort({ rank: 1 })
      .lean();

    // `null` means unlimited, so normalise the absent value before comparing.
    const limit = album.selectionLimit ?? null;

    return ok(res, {
      selections: selections.map((s) => ({
        photoId: String(s.photoId),
        rank: s.rank,
        note: s.note,
      })),
      limit,
      remaining: limit === null ? null : Math.max(0, limit - selections.length),
    });
  }),
);

const addSchema = z.object({
  albumId: z.string().min(1),
  photoId: z.string().min(1),
  note: z.string().trim().max(300).optional(),
});

/**
 * Add one photo to the selection.
 *
 * The limit check and the insert are not atomic on their own, so the album's
 * `counts.selected` is bumped with a guarded `$inc` that only applies while the
 * count is still below the limit - that conditional update is what makes two
 * concurrent requests unable to both slip past a limit of 1.
 */
router.post(
  '/',
  authenticate,
  requireClient,
  validateBody(addSchema),
  asyncHandler(async (req, res) => {
    const album = await assertAlbumAccess(req.body.albumId, req.ctx);
    if (String(album.clientId) !== String(req.ctx.userId)) {
      throw ApiError.forbidden('That album is not yours.');
    }
    if (album.status !== 'selection_open') {
      throw ApiError.conflict(
        album.status === 'selection_complete' || album.status === 'final'
          ? ALBUM_ERRORS.completed
          : ALBUM_ERRORS.notOpen,
      );
    }

    const photoId = objectId(req.body.photoId, 'photo id');
    const inAlbum = await AlbumModel.findOne({ _id: album._id, projectId: album.projectId })
      .select('_id')
      .lean();
    if (!inAlbum) throw ApiError.notFound('That album does not exist.');

    const photo = await PhotoModel.findOne({ _id: photoId, albumId: album._id }).select('_id').lean();
    if (!photo) throw ApiError.badRequest(ALBUM_ERRORS.notYours);

    const existing = await PhotoSelectionModel.findOne({
      clientId: req.ctx.userId,
      albumId: album._id,
      photoId,
    }).select('_id');
    if (existing) return ok(res, { selection: existing, alreadySelected: true }, 'Already selected.');

    // The limit check and the insert are not atomic on their own, so the album's
    // `counts.selected` is bumped with a guarded update that only applies while the
    // count is still below the limit. That conditional update is what stops two
    // concurrent requests from both slipping past a limit of 1. Returning the
    // document afterwards gives the new rank from the same write, so ranks cannot
    // collide when two adds land at once.
    const limit = album.selectionLimit ?? null;
    const claimed = await AlbumModel.findOneAndUpdate(
      {
        _id: album._id,
        status: 'selection_open',
        ...(limit === null ? {} : { $expr: { $lt: ['$counts.selected', limit] } }),
      },
      { $inc: { 'counts.selected': 1 } },
      { new: true },
    );
    if (!claimed) {
      throw ApiError.conflict(ALBUM_ERRORS.limitReached, { limit });
    }

    const selected = claimed.counts.selected;
    try {
      const selection = await PhotoSelectionModel.create({
        clientId: req.ctx.userId,
        photoId,
        albumId: album._id,
        projectId: album.projectId,
        photographerId: album.photographerId,
        rank: selected,
        note: req.body.note ?? '',
      });

      await refreshProjectCounts(album.projectId);
      await maybeNotifyCompletion(claimed, selected);

      return created(res, { selection, remaining: remainingFor(claimed, selected) }, 'Photo selected.');
    } catch (error) {
      // The counter was already bumped, so a failed insert has to give the slot
      // back rather than permanently shrink the client's allowance.
      await AlbumModel.updateOne(
        { _id: album._id },
        { $inc: { 'counts.selected': -1 }, $set: { completionNotifiedAt: null } },
      ).catch(() => undefined);
      throw error;
    }
  }),
);

router.delete(
  '/:selectionId',
  authenticate,
  requireClient,
  asyncHandler(async (req, res) => {
    const selection = await PhotoSelectionModel.findById(objectId(req.params.selectionId, 'selection id'));
    if (!selection) throw ApiError.notFound('That selection no longer exists.');
    // Only the client who made the selection can withdraw it.
    if (String(selection.clientId) !== String(req.ctx.userId)) {
      throw ApiError.forbidden('That selection is not yours.');
    }

    const album = await assertAlbumAccess(selection.albumId, req.ctx);
    if (album.status !== 'selection_open') {
      throw ApiError.conflict(ALBUM_ERRORS.completed);
    }

    await selection.deleteOne();
    await AlbumModel.updateOne(
      { _id: album._id },
      { $inc: { 'counts.selected': -1 }, $set: { completionNotifiedAt: null } },
    );
    await refreshProjectCounts(album.projectId);

    return noContent(res, 'Selection removed.');
  }),
);

const reorderSchema = z.object({
  photoIds: z.array(z.string()).min(1).max(500),
});

/**
 * Save the client's own ordering of their picks. Ranks are rewritten from the
 * submitted order, so what the client sees after a drag is what is stored.
 */
router.put(
  '/reorder',
  authenticate,
  requireClient,
  validateBody(reorderSchema.extend({ albumId: z.string().min(1) })),
  asyncHandler(async (req, res) => {
    const album = await assertAlbumAccess(req.body.albumId, req.ctx);
    if (String(album.clientId) !== String(req.ctx.userId)) {
      throw ApiError.forbidden('That album is not yours.');
    }
    if (album.status !== 'selection_open') throw ApiError.conflict(ALBUM_ERRORS.completed);

    const ids = (req.body.photoIds as string[]).map((id: string) => objectId(id, 'photo id'));
    const current = await PhotoSelectionModel.find({
      clientId: req.ctx.userId,
      albumId: album._id,
    })
      .select('_id photoId')
      .lean();

    if (current.length !== ids.length) {
      throw ApiError.badRequest('Send every selected photo, or none.');
    }

    const owned = new Set(current.map((s: { photoId: Types.ObjectId }) => String(s.photoId)));
    if (!ids.every((id: Types.ObjectId) => owned.has(String(id)))) {
      throw ApiError.badRequest(ALBUM_ERRORS.notYours);
    }

    await PhotoSelectionModel.bulkWrite(
      ids.map((photoId: Types.ObjectId, index: number) => ({
        updateOne: {
          filter: { clientId: req.ctx.userId, albumId: album._id, photoId },
          update: { $set: { rank: index + 1 } },
        },
      })),
    );

    return ok(res, { selections: ids.length }, 'Order saved.');
  }),
);

/** Submit the selection. Final: the album locks and the studio is notified. */
router.post(
  '/submit',
  authenticate,
  requireClient,
  validateBody(z.object({ albumId: z.string().min(1) })),
  asyncHandler(async (req, res) => {
    const album = await assertAlbumAccess(req.body.albumId, req.ctx);
    if (String(album.clientId) !== String(req.ctx.userId)) {
      throw ApiError.forbidden('That album is not yours.');
    }
    if (album.status !== 'selection_open') throw ApiError.conflict(ALBUM_ERRORS.completed);

    const selected = await PhotoSelectionModel.countDocuments({
      clientId: req.ctx.userId,
      albumId: album._id,
    });
    if (selected === 0) throw ApiError.badRequest('Select at least one photo before submitting.');

    album.status = 'selection_complete';
    album.selectionCompletedAt = new Date();
    album.completionNotifiedAt = new Date();
    await album.save();

    await advance({
      projectId: album.projectId,
      trigger: 'SELECTION_COMPLETED',
      actorId: req.ctx.userId,
      description: `${selected} photos selected for ${album.name}.`,
    });

    await refreshProjectCounts(album.projectId);

    return ok(res, { album, selected }, 'Thank you. Your selection has been submitted.');
  }),
);

/* -------------------------------------------------------------------------- */
/* Photographer: reading the client's picks                                    */
/* -------------------------------------------------------------------------- */

router.get(
  '/album/:albumId',
  authenticate,
  requirePhotographer,
  asyncHandler(async (req, res) => {
    const album = await assertAlbumAccess(req.params.albumId, req.ctx);
    if (String(album.photographerId) !== String(req.ctx.tenantId)) {
      throw ApiError.forbidden('That album belongs to another studio.');
    }

    const selections = await PhotoSelectionModel.find({ albumId: album._id })
      .sort({ rank: 1 })
      .populate('clientId', 'name email avatar')
      .lean();

    return ok(res, {
      album,
      selections: selections.map((s) => {
        // `populate` replaces the ObjectId with the projected user document.
        const client = s.clientId as unknown as { name: string; email: string; avatar?: string } | null;
        return {
          id: String(s._id),
          photoId: String(s.photoId),
          rank: s.rank,
          note: s.note,
          client: client ? { name: client.name, email: client.email, avatar: client.avatar ?? '' } : null,
          selectedAt: s.createdAt,
        };
      }),
      total: selections.length,
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The album fields the helpers below read. Kept structural so both
 * `assertAlbumAccess` (a hydrated document) and `findOneAndUpdate` (a query
 * document) satisfy it without a cast.
 */
type AlbumDoc = {
  _id: unknown;
  selectionLimit?: number | null;
  completionNotifiedAt?: Date | null;
  photographerId: Types.ObjectId;
  projectId: Types.ObjectId;
  name: string;
};

function remainingFor(album: AlbumDoc, count: number): number | null {
  const limit = album.selectionLimit ?? null;
  return limit === null ? null : Math.max(0, limit - count);
}

/** Tell the photographer once, when the client reaches the required count. */
async function maybeNotifyCompletion(album: AlbumDoc, count: number): Promise<void> {
  const limit = album.selectionLimit ?? null;
  if (limit === null || count < limit) return;
  if (album.completionNotifiedAt) return;

  // Claim the notice with a conditional update so two concurrent adds that both
  // cross the limit cannot send the photographer two emails.
  const claimed = await AlbumModel.updateOne(
    { _id: album._id, completionNotifiedAt: null },
    { $set: { completionNotifiedAt: new Date() } },
  );
  if (claimed.modifiedCount === 0) return;

  await notify({
    userId: album.photographerId,
    photographerId: album.photographerId,
    projectId: album.projectId,
    type: 'selection_completed',
    title: 'Album selection complete',
    message: `Your client has selected all ${count} photos for ${album.name}.`,
    link: `/projects/${String(album.projectId)}/album-selection`,
    priority: 'high',
  });
}

export default router;
