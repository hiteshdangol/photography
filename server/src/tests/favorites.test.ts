import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from './setup.js';
import { api, body, approveBooking, type AuthSession } from './helpers/auth.js';
import { PhotoModel, ProjectModel } from '../models/index.js';

/**
 * Favourites hydration.
 *
 * The favourites screen renders the same grid as the gallery, so the list has to
 * arrive with each photo in full. These tests pin that, and pin the rules that
 * keep a private list private: it is the client's own favourites, and it can only
 * ever contain photos from that client's own galleries.
 */

interface FavoriteDto {
  id: string;
  caption: string;
  isHighlight: boolean;
  aspectRatio: number;
  favoritedAt: string | null;
  urls: { thumbnail: string; gallery: string; original: string };
}

/** Reads a client's favourites with a plain supertest call. */
function favoritesOf(client: AuthSession) {
  return request(app)
    .get('/api/favorites')
    .set('Authorization', `Bearer ${client.user.accessToken}`)
    .expect(200);
}

async function seedGallery(): Promise<{
  photographer: AuthSession;
  client: AuthSession;
  projectId: string;
  photoIds: string[];
}> {
  const { photographer, client, projectId } = await approveBooking(app);

  const project = await ProjectModel.findById(projectId);
  if (!project) throw new Error('fixture project missing');

  const photos = await PhotoModel.insertMany(
    [
      {
        filename: 'fav-a.jpg',
        mimeType: 'image/jpeg',
        width: 1800,
        height: 1200,
        aspectRatio: 1.5,
        caption: 'First look',
        isHighlight: true,
      },
      {
        filename: 'fav-b.jpg',
        mimeType: 'image/jpeg',
        width: 1200,
        height: 1800,
        aspectRatio: 0.6667,
        caption: 'Second look',
      },
    ].map((photo, index) => ({
      ...photo,
      projectId: project._id,
      photographerId: project.photographerId,
      clientId: project.clientId,
      originalKey: `favourites/${index}/original.jpg`,
      optimizedKey: `favourites/${index}/optimized.jpg`,
      thumbnailKey: `favourites/${index}/thumbnail.jpg`,
    })),
  );

  const photoIds = photos.map((p) => String(p._id));
  await api(app, client).post('/api/favorites').send({ photoIds }).expect(200);

  return { photographer, client, projectId, photoIds };
}

describe('favourites list', () => {
  it('gives the owning client every field the grid needs', async () => {
    const { client } = await seedGallery();

    const res = await favoritesOf(client);
    const data = body<{ favorites: FavoriteDto[]; count: number }>(res);

    expect(data.count).toBe(2);
    expect(data.favorites).toHaveLength(2);

    for (const favorite of data.favorites) {
      expect(favorite.id).toBeTruthy();
      expect(favorite.caption).toBeTruthy();
      expect(favorite.aspectRatio).toBeGreaterThan(0);
      expect(favorite.favoritedAt).toBeTruthy();
      // Authorised URLs, never storage keys.
      expect(favorite.urls.thumbnail).toContain(`/api/photos/${favorite.id}/file`);
      expect(favorite.urls.thumbnail).toContain('variant=thumbnail');
      expect(favorite.urls.original).toContain('variant=original');
    }
  });

  it('preserves each photo aspect ratio for masonry layout', async () => {
    const { client } = await seedGallery();

    const res = await favoritesOf(client);
    const ratios = body<{ favorites: FavoriteDto[] }>(res).favorites.map((f) => f.aspectRatio);

    // Landscape and portrait must not collapse to one value, or the grid tiles
    // every photo at the same height and crops the framing.
    expect(new Set(ratios.map((r) => r.toFixed(2))).size).toBe(2);
  });

  it('keeps the highlight flag the gallery uses for the reel', async () => {
    const { client } = await seedGallery();

    const res = await favoritesOf(client);
    const highlights = body<{ favorites: FavoriteDto[] }>(res).favorites.filter((f) => f.isHighlight);

    expect(highlights).toHaveLength(1);
    expect(highlights[0]?.caption).toBe('First look');
  });

  it('never exposes a client favourites list to the photographer', async () => {
    const { photographer, projectId } = await seedGallery();

    const res = await api(app, photographer).get(`/api/favorites?projectId=${projectId}`);
    // The photographer sees the per-photo *count* elsewhere, never who liked it.
    expect([403, 401]).toContain(res.status);
  });

  it('never returns another client favourites', async () => {
    await seedGallery();
    const stranger = await approveBooking(app);

    const res = await favoritesOf(stranger.client);
    expect(body<{ count: number }>(res).count).toBe(0);
  });

  it('scopes to one project when asked', async () => {
    const { client, projectId } = await seedGallery();
    const other = await approveBooking(app);

    const all = await favoritesOf(client);
    expect(body<{ count: number }>(all).count).toBe(2);

    const scoped = await request(app)
      .get(`/api/favorites?projectId=${projectId}`)
      .set('Authorization', `Bearer ${client.user.accessToken}`)
      .expect(200);
    expect(body<{ count: number }>(scoped).count).toBe(2);

    const unrelated = await request(app)
      .get(`/api/favorites?projectId=${other.projectId}`)
      .set('Authorization', `Bearer ${client.user.accessToken}`)
      .expect(200);
    expect(body<{ count: number }>(unrelated).count).toBe(0);
  });

  it('drops a favourite whose photo was deleted instead of returning a dangling id', async () => {
    const { client, photoIds } = await seedGallery();

    await PhotoModel.deleteOne({ _id: photoIds[0] });

    const res = await favoritesOf(client);
    const data = body<{ favorites: FavoriteDto[]; count: number }>(res);

    expect(data.count).toBe(1);
    expect(data.favorites[0]?.id).toBe(photoIds[1]);
  });

  it('favouriting is idempotent', async () => {
    const { client, photoIds } = await seedGallery();

    const res = await api(app, client).post('/api/favorites').send({ photoIds }).expect(200);
    expect(body<{ added: number }>(res).added).toBe(0);

    const list = await favoritesOf(client);
    expect(body<{ count: number }>(list).count).toBe(2);
  });

  it('refuses to favourite a photo from another client gallery', async () => {
    const { photoIds } = await seedGallery();
    const stranger = await approveBooking(app);

    const res = await api(app, stranger.client).post('/api/favorites').send({ photoIds });
    expect(res.status).toBe(400);
  });

  it('toggles a single photo off, which is what the heart button does', async () => {
    const { client, photoIds } = await seedGallery();
    expect(body<{ count: number }>(await favoritesOf(client)).count).toBe(2);

    const removed = await api(app, client)
      .post('/api/favorites/toggle')
      .send({ photoId: photoIds[0] })
      .expect(200);
    expect(body<{ favorited: boolean }>(removed).favorited).toBe(false);
    expect(body<{ count: number }>(await favoritesOf(client)).count).toBe(1);

    const restored = await api(app, client)
      .post('/api/favorites/toggle')
      .send({ photoId: photoIds[0] })
      .expect(200);
    expect(body<{ favorited: boolean }>(restored).favorited).toBe(true);
    expect(body<{ count: number }>(await favoritesOf(client)).count).toBe(2);
  });

  it('refuses to toggle a photo belonging to another client', async () => {
    const { photoIds } = await seedGallery();
    const stranger = await approveBooking(app);

    const res = await api(app, stranger.client)
      .post('/api/favorites/toggle')
      .send({ photoId: photoIds[0] });
    expect(res.status).toBe(404);
  });
});