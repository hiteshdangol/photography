import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from './setup.js';
import { api, body, register, approveBooking } from './helpers/auth.js';
import { PhotoModel, ProjectModel } from '../models/index.js';

/**
 * Share-link access.
 *
 * A share token is the one credential in LensFlow that grants read access to a
 * project to somebody with no relationship to it - which is the entire point of
 * sending a gallery to a friend. These tests pin the rules that make that safe
 * and usable:
 *
 *   - a live token lists the gallery and resolves it for a signed-out guest;
 *   - a token is bound to exactly one project and cannot be replayed;
 *   - publication is still required, so an unpublished gallery stays private;
 *   - `maxAccesses` counts gallery *opens*, not image requests, so opening one
 *     gallery does not burn a limit with 120 rendition fetches;
 *   - a token never weakens the rules for signed-in callers.
 */

interface GallerySummary {
  id: string;
  title: string;
  counts: { photos: number };
}

async function publishWithPhotos(projectId: string, count = 2): Promise<void> {
  const project = await ProjectModel.findById(projectId);
  if (!project) throw new Error('fixture project missing');

  await PhotoModel.insertMany(
    Array.from({ length: count }, (_unused, index) => ({
      projectId: project._id,
      photographerId: project.photographerId,
      clientId: project.clientId,
      filename: `share-fixture-${index}.jpg`,
      originalFilename: `fixture-${index}.jpg`,
      mimeType: 'image/jpeg',
      originalKey: `fixtures/${index}/original.jpg`,
      optimizedKey: `fixtures/${index}/optimized.jpg`,
      thumbnailKey: `fixtures/${index}/thumbnail.jpg`,
      width: 2000,
      height: 1333,
      aspectRatio: 2000 / 1333,
      category: 'other',
    })),
  );

  project.gallery.published = true;
  project.gallery.publishedAt = new Date();
  project.gallery.totalPhotos = count;
  await project.save();
}

/** Creates a link and returns the raw token, which the server only ever shows once. */
async function createShare(
  photographerToken: string,
  projectId: string,
  options: { expiresAt?: string; maxAccesses?: number } = {},
): Promise<string> {
  const res = await request(app)
    .post('/api/shares')
    .set('Authorization', `Bearer ${photographerToken}`)
    .send({ projectId, label: 'fixture', ...options })
    .expect(201);

  const data = body<{ url: string }>(res);
  const token = data.url.split('/g/')[1];
  if (!token) throw new Error('share url carried no token');
  return token;
}

/**
 * Opens a gallery the way the client does, returning the view grant that the
 * client then echoes back on every photo read.
 */
async function openGallery(
  token: string,
): Promise<{ viewToken: string; body: ReturnType<typeof body<Record<string, unknown>>> }> {
  const res = await request(app).get(`/api/shares/resolve?token=${token}`).expect(200);
  return { viewToken: body<{ viewToken: string }>(res).viewToken, body: body(res) };
}

/** An unrelated project with its own published gallery, to test replay. */
async function otherPublishedProject(): Promise<{ photographerToken: string; projectId: string }> {
  const { photographer, projectId } = await approveBooking(app);
  await publishWithPhotos(projectId, 1);
  return { photographerToken: photographer.user.accessToken, projectId };
}

describe('share link resolves for a signed-out guest', () => {
  it('returns the gallery and reports the viewer as a guest', async () => {
    const { photographer, projectId } = await approveBooking(app);
    await publishWithPhotos(projectId);
    const token = await createShare(photographer.user.accessToken, projectId);

    const res = await request(app).get(`/api/shares/resolve?token=${token}`).expect(200);
    const data = body<{
      project: GallerySummary;
      viewer: { role: string; signedIn: boolean };
    }>(res);

    expect(data.project.id).toBe(projectId);
    expect(data.viewer.role).toBe('guest');
    expect(data.viewer.signedIn).toBe(false);
  });

  it('lets the same guest list the photos, not just load the bytes', async () => {
    const { photographer, projectId } = await approveBooking(app);
    await publishWithPhotos(projectId, 3);
    const token = await createShare(photographer.user.accessToken, projectId);

    const res = await request(app).get(`/api/photos?projectId=${projectId}&token=${token}`).expect(200);
    const data = body<{ photos: { id: string; caption: string | null }[]; count: number }>(res);

    expect(data.count).toBe(3);
    expect(data.photos).toHaveLength(3);
  });

  it('lets a signed-in non-participant use the link, and reports their real role', async () => {
    const { photographer, projectId } = await approveBooking(app);
    await publishWithPhotos(projectId);
    const token = await createShare(photographer.user.accessToken, projectId);
    const stranger = await register(app, 'client');

    const res = await api(app, stranger).get(`/api/shares/resolve?token=${token}`).expect(200);
    const data = body<{ viewer: { role: string; signedIn: boolean } }>(res);

    // A stranger is not the photographer, the booked client, or an admin, so the
    // only reason they are here is the token.
    expect(data.viewer.role).toBe('guest');
    expect(data.viewer.signedIn).toBe(true);
  });
});

describe('share token is bound to one project', () => {
  it('refuses to list another project with a valid token', async () => {
    const { photographer, projectId } = await approveBooking(app);
    await publishWithPhotos(projectId);
    const token = await createShare(photographer.user.accessToken, projectId);
    const other = await otherPublishedProject();

    const res = await request(app).get(`/api/photos?projectId=${other.projectId}&token=${token}`);
    expect(res.status).toBe(403);
  });

  it('refuses a token that was never issued', async () => {
    const { projectId } = await otherPublishedProject();
    const res = await request(app).get(`/api/photos?projectId=${projectId}&token=${'x'.repeat(43)}`);
    expect(res.status).toBe(403);
  });
});

describe('an unusable token is refused', () => {
  it('rejects a missing token on a signed-out read', async () => {
    const { projectId } = await otherPublishedProject();
    const res = await request(app).get(`/api/photos?projectId=${projectId}`);
    expect(res.status).toBe(403);
  });

  it('rejects an expired token and says why', async () => {
    const { photographer, projectId } = await approveBooking(app);
    await publishWithPhotos(projectId);
    const token = await createShare(photographer.user.accessToken, projectId, {
      expiresAt: new Date(Date.now() + 1000).toISOString(),
    });

    // Wait past the expiry rather than back-dating the link, so the test proves
    // the check is on read and not only at creation.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const res = await request(app).get(`/api/shares/resolve?token=${token}`).expect(403);
    expect(res.body.message).toMatch(/expired/i);
  });

  it('rejects a revoked token', async () => {
    const { photographer, projectId } = await approveBooking(app);
    await publishWithPhotos(projectId);
    const token = await createShare(photographer.user.accessToken, projectId);

    const shares = await request(app)
      .get(`/api/shares?projectId=${projectId}`)
      .set('Authorization', `Bearer ${photographer.user.accessToken}`)
      .expect(200);
    const shareId = body<{ shares: { id: string }[] }>(shares).shares[0]!.id;

    await api(app, photographer)
      .patch(`/api/shares/${shareId}`)
      .send({ active: false })
      .expect(200);

    const res = await request(app).get(`/api/photos?projectId=${projectId}&token=${token}`);
    expect(res.status).toBe(403);
  });

  it('rejects a second visitor once the access limit is spent', async () => {
    const { photographer, projectId } = await approveBooking(app);
    await publishWithPhotos(projectId);
    const token = await createShare(photographer.user.accessToken, projectId, { maxAccesses: 1 });

    await request(app).get(`/api/shares/resolve?token=${token}`).expect(200);
    const second = await request(app).get(`/api/shares/resolve?token=${token}`).expect(403);
    expect(second.body.message).toMatch(/access limit/i);
  });

  it('requires the gallery to be published even with a live token', async () => {
    const { photographer, projectId } = await approveBooking(app);
    // No photos, so the gallery cannot be published through the API. Mint the
    // share straight against the model to prove publication is still enforced.
    await publishWithPhotos(projectId);
    const token = await createShare(photographer.user.accessToken, projectId);

    await ProjectModel.updateOne({ _id: projectId }, { $set: { 'gallery.published': false } });

    const res = await request(app).get(`/api/photos?projectId=${projectId}&token=${token}`);
    expect(res.status).toBe(404);
  });
});

describe('an access limit counts gallery opens, not image requests', () => {
  it('counts one open, not one request per thumbnail', async () => {
    const { photographer, projectId } = await approveBooking(app);
    await publishWithPhotos(projectId, 12);
    const token = await createShare(photographer.user.accessToken, projectId, { maxAccesses: 1 });

    const { viewToken } = await openGallery(token);

    // A real gallery page issues one request per thumbnail. Those must not eat
    // the remaining allowance, or the first visitor to scroll sees 403s.
    for (let i = 0; i < 12; i += 1) {
      await request(app)
        .get(`/api/photos?projectId=${projectId}&token=${token}&viewToken=${viewToken}`)
        .expect(200);
    }

    const shares = await request(app)
      .get(`/api/shares?projectId=${projectId}`)
      .set('Authorization', `Bearer ${photographer.user.accessToken}`)
      .expect(200);
    const share = body<{ shares: { accessCount: number; remaining: number }[] }>(shares).shares[0]!;

    expect(share.accessCount).toBe(1);
    expect(share.remaining).toBe(0);
  });

  it('keeps the already-open visitor browsing after the limit is spent', async () => {
    const { photographer, projectId } = await approveBooking(app);
    await publishWithPhotos(projectId, 12);
    const token = await createShare(photographer.user.accessToken, projectId, { maxAccesses: 1 });

    const { viewToken } = await openGallery(token);

    // No grant: the limit is spent, so a fresh visitor is turned away.
    await request(app).get(`/api/photos?projectId=${projectId}&token=${token}`).expect(403);

    // The visitor who opened it keeps their grant and can still browse.
    const res = await request(app)
      .get(`/api/photos?projectId=${projectId}&token=${token}&viewToken=${viewToken}`)
      .expect(200);
    expect(body<{ count: number }>(res).count).toBe(12);
  });

  it('does not accept a view grant minted for a different gallery', async () => {
    const { photographer, projectId } = await approveBooking(app);
    await publishWithPhotos(projectId);
    const token = await createShare(photographer.user.accessToken, projectId, { maxAccesses: 1 });
    const other = await otherPublishedProject();

    const { viewToken } = await openGallery(token);

    // Replaying the grant against another project must grant nothing, even
    // though the signature is genuine.
    const res = await request(app).get(
      `/api/photos?projectId=${other.projectId}&token=${other.photographerToken}&viewToken=${viewToken}`,
    );
    expect(res.status).toBe(403);
  });

  it('does not accept a forged view grant', async () => {
    const { photographer, projectId } = await approveBooking(app);
    await publishWithPhotos(projectId);
    const token = await createShare(photographer.user.accessToken, projectId, { maxAccesses: 1 });

    await request(app).get(`/api/shares/resolve?token=${token}`).expect(200);
    await request(app).get(`/api/photos?projectId=${projectId}&token=${token}`).expect(403);

    const forged = await request(app).get(
      `/api/photos?projectId=${projectId}&token=${token}&viewToken=${'not.a.jwt'}`,
    );
    expect(forged.status).toBe(403);
  });
});

describe('a share token never weakens the rules for signed-in callers', () => {
  it('still hides a project from a signed-in stranger who has no token', async () => {
    const { projectId } = await otherPublishedProject();
    const stranger = await register(app, 'photographer');

    const res = await api(app, stranger).get(`/api/photos?projectId=${projectId}`);
    expect(res.status).toBe(404);
  });

  it('still lets the owner list the gallery without presenting a token', async () => {
    const { photographer, projectId } = await approveBooking(app);
    await publishWithPhotos(projectId, 2);

    const res = await api(app, photographer).get(`/api/photos?projectId=${projectId}`).expect(200);
    expect(body<{ count: number }>(res).count).toBe(2);
  });

  it('does not let a share token grant a write', async () => {
    const { photographer, projectId } = await approveBooking(app);
    await publishWithPhotos(projectId);
    const token = await createShare(photographer.user.accessToken, projectId);

    const res = await request(app)
      .patch(`/api/photos/000000000000000000000000`)
      .set('Authorization', `Bearer ${photographer.user.accessToken}`)
      .send({ caption: 'nope', token })
      .expect(404);

    expect(res.status).toBe(404);
  });
});