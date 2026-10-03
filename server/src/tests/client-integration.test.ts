import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from './setup.js';
import {
  api,
  body,
  register,
  approveBooking,
  openWorkingHours,
  workingSlot,
  TEST_PASSWORD,
} from './helpers/auth.js';

/**
 * Guards the endpoints the SPA actually calls.
 *
 * Each of these three broke while the server and client were developed
 * independently, and none of them fail `typecheck` or `build`:
 *
 *  1. DashboardPage requested `/analytics/overview`, which never existed. Only
 *     `/summary`, `/revenue`, `/bookings`, `/clients`, `/engagement` and
 *     `/testimonials` are mounted, so the page rendered its error state forever.
 *  2. BookingsPage requested `/bookings/mine` for clients. That path fell
 *     through to `GET /bookings/:id`, where `objectId('mine')` rejected it with
 *     400 "Invalid booking id". The role-scoped `GET /bookings` already covers
 *     both roles.
 *  3. The booking list now populates both `clientId` and `photographerId`, so the
 *     page can read either party's name. It reads `priceSnapshot.totalMinor` and
 *     `priceSnapshot.packageName`; the top-level `clientName` / `packageName` /
 *     `totalMinor` it asked for do not exist, and `lean()` strips the schema's
 *     `id` virtual so `_id` is the only key.
 *
 * Sessions are created per test: the shared `afterEach` truncates every
 * collection between tests, including users.
 */
describe('client/server contract', () => {
  it('DashboardPage calls GET /analytics/summary, which exists', async () => {
    const photographer = await register(app, 'photographer');
    await api(app, photographer).get('/api/analytics/summary').expect(200);
  });

  it('/analytics/summary returns the fields DashboardPage reads', async () => {
    const photographer = await register(app, 'photographer');
    const res = await api(app, photographer).get('/api/analytics/summary?period=all').expect(200);
    const data = body<{
      projects: number;
      bookings: { total: number; conversion: number; bookedMinor: number };
      revenue: { receivedMinor: number; outstandingMinor: number };
    }>(res);

    // `projects` is a bare number. The page previously read `projects.total`,
    // which silently rendered 0.
    expect(typeof data.projects).toBe('number');
    expect(typeof data.bookings.total).toBe('number');
    expect(typeof data.bookings.conversion).toBe('number');
    expect(typeof data.revenue.receivedMinor).toBe('number');
    expect(typeof data.revenue.outstandingMinor).toBe('number');
  });

  it('the old dashboard URL /analytics/overview 404s', async () => {
    const photographer = await register(app, 'photographer');
    await api(app, photographer).get('/api/analytics/overview').expect(404);
  });

  it('/bookings/mine is still not a real route; it falls through to /:id', async () => {
    const client = await register(app, 'client');
    const res = await api(app, client).get('/api/bookings/mine');

    // Documents exactly why the client must never call this path again.
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Invalid booking id');
  });

  it('GET /bookings serves both roles from the single role-scoped endpoint', async () => {
    const photographer = await register(app, 'photographer');
    const client = await register(app, 'client');

    for (const session of [photographer, client]) {
      const res = await api(app, session).get('/api/bookings').expect(200);
      expect(Array.isArray(body<{ bookings: unknown[] }>(res).bookings)).toBe(true);
    }
  });

  it('a client listing shows only their own bookings', async () => {
    const photographer = await register(app, 'photographer');
    const ownClient = await register(app, 'client');
    const otherClient = await register(app, 'client');
    await openWorkingHours(app, photographer);

    await api(app, ownClient)
      .post('/api/bookings/request')
      .send({
        photographerId: photographer.user.id,
        eventType: 'Wedding',
        eventDate: workingSlot(18).eventDate,
        startTime: workingSlot(18).startTime,
        endTime: workingSlot(18).endTime,
        location: 'Test venue',
      })
      .expect(201);

    const mineRes = await api(app, ownClient).get('/api/bookings').expect(200);
    expect(body<{ bookings: unknown[] }>(mineRes).bookings).toHaveLength(1);

    const theirsRes = await api(app, otherClient).get('/api/bookings').expect(200);
    expect(body<{ bookings: unknown[] }>(theirsRes).bookings).toHaveLength(0);
  });

  it('booking rows expose the fields BookingsPage renders', async () => {
    const { photographer } = await approveBooking(app);

    const res = await api(app, photographer).get('/api/bookings').expect(200);
    const rows = body<{ bookings: Record<string, unknown>[] }>(res).bookings;
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    expect(row._id).toBeTruthy();
    expect(row.eventType).toBeTruthy();
    expect(row.status).toBeTruthy();
    expect(row).toHaveProperty('priceSnapshot');
    expect(row).toHaveProperty('clientId');
    // The populated client object is what `partyName` reads from.
    expect(typeof row.clientId).toBe('object');
    expect(row).toHaveProperty('photographerId');
    /* Regression: the list populated only `clientId`, so a client received a bare
     * `photographerId` ObjectId and the UI had to substitute the internal booking
     * reference for the photographer's name. */
    expect(typeof row.photographerId).toBe('object');
  });

  it('a client can read the photographer name and package they booked', async () => {
    const { client } = await approveBooking(app);

    const res = await api(app, client).get('/api/bookings').expect(200);
    const rows = body<{
      bookings: {
        photographerId: { _id: string; name?: string };
        priceSnapshot: { packageName?: string; totalMinor?: number };
      }[];
    }>(res).bookings;
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    /* Both are what the client bookings page renders. A missing `name` here is
     * exactly the bug where "photographer cannot be seen". */
    expect(row.photographerId?.name).toBeTruthy();
    expect(row.priceSnapshot).toBeDefined();
    expect(typeof row.priceSnapshot.totalMinor).toBe('number');
  });

  it('unauthenticated booking requests are rejected', async () => {
    await request(app).get('/api/bookings').expect(401);
  });
});

describe('auth surface', () => {
  it('registers, logs in, and returns the user with an id (not _id)', async () => {
    // Auth responses go through publicUser(), which renames `_id` to `id`.
    // Reading `_id` yields undefined, which is how a booking request ends up
    // 422 with "expected string, received undefined" for photographerId.
    const session = await register(app, 'photographer');
    expect(session.user.id).toMatch(/^[0-9a-f]{24}$/);

    const res = await request(app).post('/api/auth/login').send({
      email: session.user.email,
      password: TEST_PASSWORD,
    });

    const { user } = body<{ user: { id: string; email: string } }>(res);
    expect(user.id).toBe(session.user.id);
    expect(user.email).toBe(session.user.email);
  });

  it('creates a client profile automatically on registration', async () => {
    const client = await register(app, 'client');
    const res = await api(app, client).get('/api/auth/me').expect(200);

    expect(body<{ user: { id: string; role: string } }>(res).user.id).toBe(client.user.id);
  });

  it('rejects a duplicate email', async () => {
    const email = 'dupe@example.test';
    await register(app, 'photographer', { email });

    const res = await request(app).post('/api/auth/register').send({
      email,
      password: TEST_PASSWORD,
      name: 'Impostor',
      role: 'photographer',
    });

    expect(res.status).toBe(409);
  });

  it('refuses a wrong password', async () => {
    const session = await register(app, 'photographer');
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: session.user.email, password: 'definitely-not-the-password' });

    expect(res.status).toBe(401);
  });
});
