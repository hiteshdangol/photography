import type { Types } from 'mongoose';
import {
  AlbumModel,
  FavoriteModel,
  PhotoCommentModel,
  PhotoModel,
  PhotoSelectionModel,
  ProjectModel,
} from '../models/index.js';

/**
 * Denormalised counters.
 *
 * Projects and albums carry photo/selection/album counts so list endpoints do not
 * have to aggregate on every read. That means every write path that changes the
 * underlying collection has to refresh the counter, and doing that in one place is
 * what stops the numbers drifting apart between routes.
 */

/** Recount a project's denormalised totals from the source collections. */
export async function refreshProjectCounts(projectId: Types.ObjectId): Promise<void> {
  const [photos, highlights, albums, selections, favorites] = await Promise.all([
    PhotoModel.countDocuments({ projectId }),
    PhotoModel.countDocuments({ projectId, isHighlight: true }),
    AlbumModel.countDocuments({ projectId }),
    PhotoSelectionModel.countDocuments({ projectId }),
    FavoriteModel.countDocuments({ projectId }),
  ]);

  await ProjectModel.updateOne(
    { _id: projectId },
    { $set: { 'counts.photos': photos, 'counts.highlights': highlights, 'counts.albums': albums, 'counts.selections': selections, 'counts.favorites': favorites, 'gallery.totalPhotos': photos } },
  );
}

/** Recount one album's denormalised totals. */
export async function refreshAlbumCounts(albumId: Types.ObjectId): Promise<void> {
  const [photos, selected] = await Promise.all([
    PhotoModel.countDocuments({ albumId }),
    PhotoSelectionModel.countDocuments({ albumId }),
  ]);

  await AlbumModel.updateOne({ _id: albumId }, { $set: { 'counts.photos': photos, 'counts.selected': selected } });
}

/** Recount one photo's denormalised totals. */
export async function refreshPhotoCounts(photoId: Types.ObjectId): Promise<void> {
  const [favorites, selections, comments] = await Promise.all([
    FavoriteModel.countDocuments({ photoId }),
    PhotoSelectionModel.countDocuments({ photoId }),
    PhotoCommentModel.countDocuments({ photoId, deletedAt: null }),
  ]);

  await PhotoModel.updateOne(
    { _id: photoId },
    {
      $set: {
        'counts.favorites': favorites,
        'counts.selections': selections,
        'counts.comments': comments,
        favoriteCount: favorites,
        selectionCount: selections,
        commentCount: comments,
      },
    },
  );
}
