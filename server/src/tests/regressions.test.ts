import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { app, testPort } from './setup.js';
import {
  api,
  body,
  register,
  registerPair,
  approveBooking,
  workingSlot,
  outsideWorkingSlot,
  openWorkingHours,
  tenantIdFor,
  registerSuperAdmin,
} from './helpers/auth.js';
import { connectSocket, connectSocketExpectingError, emitWithAck, once } from './helpers/socket.js';
import type { Socket as ClientSocket } from 'socket.io-client';
import { PaymentModel } from '../models/Payment.js';

/**
 * The transport regression: `new IOServer({ ...options })` passes the options
 * bag as a server argument and leaves the HTTP server unattached, so every
 * handshake fell through to the Express 404 handler and clients saw a plain
 * HTTP error instead of a socket connection. `io.ts` now passes the HTTP server
 * as the first positional argument; setup.ts mirrors production wiring.
 */
describe('Socket.IO transport', () => {
  it('is attached to the HTTP server, so a handshake is not an Express 404', async () => {
    const photographer = await register(app, 'photographer');
    const socket = await connectSocket({
      url: `http://localhost:${testPort()}`,
      token: photographer.user.accessToken,
    });

    expect(socket.connected).toBe(true);
    socket.close();
  });

  it('rejects an unauthenticated handshake with an error, not a 404', async () => {
    const error = await connectSocketExpectingError({ url: `http://localhost:${testPort()}` });
    expect(error.message.toLowerCase()).toContain('unauthorized');
  });

  /**
   * `/health` reports `realtime: isIoReady()`, which is true only once
   * `attachIo()` has run. If Socket.IO were detached again this would flip to
   * false, so the socket and HTTP surfaces are asserted together.
   */
  it('health advertises realtime while a socket is connected', async () => {
    const photographer = await register(app, 'photographer');
    const socket = await connectSocket({
      url: `http://localhost:${testPort()}`,
      token: photographer.user.accessToken,
    });

    const res = await request(app).get('/api/health').expect(200);
    expect(body<{ realtime: boolean }>(res).realtime).toBe(true);
    socket.close();
  });

  it('rejects a garbage bearer token', async () => {
    const error = await connectSocketExpectingError({
      url: `http://localhost:${testPort()}`,
      token: 'not-a-real-jwt',
    });
    expect(error.message.toLowerCase()).toContain('unauthorized');
  });
});

describe('booking approval availability regression', () => {
  /**
   * The original bug: approval re-checked availability without excluding the
   * booking being approved, so a booking always conflicted with its own slot
   * and every approval returned 409 outside_working_hours.
   */
  it('approving a booking does not conflict with the booking itself', async () => {
    const { photographer, client } = await registerPair(app);
    await openWorkingHours(app, photographer);
    const slot = workingSlot(20);

    const requested = await api(app, client)
      .post('/api/bookings/request')
      .send({
        photographerId: photographer.user.id,
        eventType: 'Wedding',
        eventDate: slot.eventDate,
        startTime: slot.startTime,
        endTime: slot.endTime,
        location: 'Test venue',
        guestCount: 50,
      })
      .expect(201);

    const bookingId = body<{ booking: { _id: string } }>(requested).booking._id;

    const approved = await api(app, photographer).post(`/api/bookings/${bookingId}/approve`).send({});
    expect(approved.status).toBe(200);
    expect(body<{ booking: { status: string } }>(approved).booking.status).toBe('approved');
  });

  it("hides an approved booking from another photographer", async () => {
    const { bookingId, projectId } = await approveBooking(app);
    const stranger = await register(app, 'photographer');

    const res = await api(app, stranger).get(`/api/bookings/${bookingId}`);
    expect(res.status).toBe(404);
    expect(projectId).toBeTruthy();
  });

  it('still refuses to double-book the same slot for a different client', async () => {
    const { photographer, client } = await registerPair(app);
    await openWorkingHours(app, photographer);
    const slot = workingSlot(25);

    const payload = {
      photographerId: photographer.user.id,
      eventType: 'Wedding',
      eventDate: slot.eventDate,
      startTime: slot.startTime,
      endTime: slot.endTime,
      location: 'Test venue',
    };

    const first = await api(app, client).post('/api/bookings/request').send(payload).expect(201);
    const firstId = body<{ booking: { _id: string } }>(first).booking._id;
    await api(app, photographer).post(`/api/bookings/${firstId}/approve`).send({}).expect(200);

    // A genuinely overlapping request must still be rejected; the ignore fix
    // must not have widened the check into a no-op.
    const rival = await register(app, 'client');
    const clash = await api(app, rival).post('/api/bookings/request').send(payload);
    expect(clash.status).toBe(409);
  });

  it('rejects a request outside the photographer working hours', async () => {
    const { photographer, client } = await registerPair(app);
    await openWorkingHours(app, photographer, [{ start: '09:00', end: '17:00' }]);
    const slot = outsideWorkingSlot(30);

    const res = await api(app, client).post('/api/bookings/request').send({
      photographerId: photographer.user.id,
      eventType: 'Wedding',
      eventDate: slot.eventDate,
      startTime: slot.startTime,
      endTime: slot.endTime,
      location: 'Test venue',
    });

    expect(res.status).toBe(409);
    expect(res.body?.code).toBe('conflict');
    expect(res.body?.errors?.reason).toBe('outside_working_hours');
  });
});

describe('booking grants chat access', () => {
  /**
   * `POST /api/chat/conversations` gates on
   * `ClientProfile.photographerIds` containing the photographer. Nothing wrote
   * that field except the private-notes upsert, so a client who booked and was
   * approved but never had a note saved got 403 from the photographer they had
   * just hired.
   *
   * The fix links the pair at request time, so this asserts the whole chain with
   * no helper call standing in for the missing write.
   */
  it('lets a client message a photographer they have requested a booking with', async () => {
    const { photographer, client } = await registerPair(app);
    await openWorkingHours(app, photographer);
    const slot = workingSlot(18);

    const requested = await api(app, client)
      .post('/api/bookings/request')
      .send({
        photographerId: photographer.user.id,
        eventType: 'Wedding',
        eventDate: slot.eventDate,
        startTime: slot.startTime,
        endTime: slot.endTime,
        location: 'Test venue',
      })
      .expect(201);
    const bookingId = body<{ booking: { _id: string } }>(requested).booking._id;

    // Still pending: the relationship must exist before the approval.
    const pending = await api(app, client)
      .post('/api/chat/conversations')
      .send({ recipientId: photographer.user.id });
    expect(pending.status).toBe(201);

    await api(app, photographer).post(`/api/bookings/${bookingId}/approve`).send({}).expect(200);
  });

  it('still refuses a client who has never booked that photographer', async () => {
    const photographer = await register(app, 'photographer');
    const stranger = await register(app, 'client');

    const res = await api(app, stranger)
      .post('/api/chat/conversations')
      .send({ recipientId: photographer.user.id });

    expect(res.status).toBe(403);
  });
});

describe('chat tenant isolation', () => {
  let sockets: ClientSocket[] = [];

  afterEach(() => {
    sockets.forEach((s) => s.close());
    sockets = [];
  });

  function open(token: string): Promise<ClientSocket> {
    return connectSocket({ url: `http://localhost:${testPort()}`, token }).then((s) => {
      sockets.push(s);
      return s;
    });
  }

  it('rejects conversation:join and message:send from a non-participant', async () => {
    const { conversationId } = await approveBooking(app);
    const outsider = await register(app, 'client');
    const outsiderSocket = await open(outsider.user.accessToken);

    const join = await emitWithAck<unknown>(outsiderSocket, 'conversation:join', { conversationId });
    expect(join.ok).toBe(false);
    expect(join.error).toBeTruthy();

    const send = await emitWithAck<unknown>(outsiderSocket, 'message:send', {
      conversationId,
      message: 'intrusion attempt',
    });
    expect(send.ok).toBe(false);

    // The outsider never joined the room, so no traffic reaches them.
    await expect(once(outsiderSocket, 'message:new', 750)).rejects.toThrow();
  });

  it('does not persist a message from a non-participant', async () => {
    const { client, conversationId } = await approveBooking(app);
    const outsider = await register(app, 'client');
    const outsiderSocket = await open(outsider.user.accessToken);

    await emitWithAck(outsiderSocket, 'message:send', { conversationId, message: 'should not persist' });

    const res = await api(app, client).get(`/api/chat/conversations/${conversationId}/messages`).expect(200);
    const messages = body<{ messages: { message: string }[] }>(res).messages;
    expect(messages.some((m) => m.message === 'should not persist')).toBe(false);
  });

  it('a participant can join and send a message', async () => {
    const { client, conversationId } = await approveBooking(app);
    const clientSocket = await open(client.user.accessToken);

    const join = await emitWithAck<unknown>(clientSocket, 'conversation:join', { conversationId });
    expect(join.ok).toBe(true);

    const send = await emitWithAck<{ _id: string }>(clientSocket, 'message:send', {
      conversationId,
      message: 'hello from the test',
    });
    expect(send.ok).toBe(true);
  });
});

describe('REST tenant isolation', () => {
  it("hides another photographer's project behind a 404, not a 403", async () => {
    const { photographer: owner, projectId } = await approveBooking(app);
    const stranger = await register(app, 'photographer');

    const res = await api(app, stranger).get(`/api/projects/${projectId}`);
    expect(res.status).toBe(404);
    expect(res.body?.code).toBe('not_found');
    expect(owner.user.role).toBe('photographer');
  });

  it('blocks a client from the photographer-only analytics surface', async () => {
    const client = await register(app, 'client');
    const res = await api(app, client).get('/api/analytics/summary');
    expect([403, 401]).toContain(res.status);
  });
});

describe('health', () => {
  it('reports ok with a live database and the realtime transport attached', async () => {
    const res = await request(app).get('/api/health').expect(200);
    const data = body<{ status: string; database: string; realtime: boolean }>(res);

    expect(data.status).toBe('ok');
    // The in-memory fallback reports 'memory'; an external MongoDB reports
    // 'external'. Both are live, which is the point of this assertion.
    expect(['memory', 'external']).toContain(data.database);
    expect(data.realtime).toBe(true);
  });
});

/**
 * Every revenue aggregate in `analytics.routes.ts` (and the admin overview)
 * matched `paidAt`. Payment has no such field -- `paidAt` only exists on
 * Invoice -- so `status: 'completed'` payments never matched a non-null date
 * and the dashboard reported zero revenue and zero transactions forever, with
 * no error anywhere. The queries now use `verifiedAt`, which every completion
 * path sets (`payment.service.ts`, `invoice.routes.ts`, the seed).
 */
describe('revenue analytics read the field Payment actually has', () => {
  /** Books a real shoot and records a completed deposit against it. */
  async function completedPayment(amountMinor: number) {
    const { photographer, client, bookingId } = await approveBooking(app);
    const paidAt = new Date();

    await PaymentModel.create({
      reference: `TEST-PAY-${bookingId.slice(-6)}`,
      bookingId,
      projectId: undefined,
      clientId: tenantIdFor(client),
      photographerId: tenantIdFor(photographer),
      provider: 'manual',
      transactionId: `test-${bookingId.slice(-6)}`,
      amountMinor,
      currency: 'NPR',
      paymentType: 'deposit',
      status: 'completed',
      verifiedAt: paidAt,
    });

    return { photographer, bookingId, paidAt, amountMinor };
  }

  it('confirms Payment has no paidAt field, which is what broke the reports', () => {
    // Pinning the schema keeps the fix honest: if someone "fixes" the reports by
    // adding a `paidAt` that nothing writes, this fails instead of silently
    // returning zero again.
    expect('paidAt' in PaymentModel.schema.paths).toBe(false);
    expect('verifiedAt' in PaymentModel.schema.paths).toBe(true);
  });

  it('summary counts a completed payment as received revenue', async () => {
    const { photographer, amountMinor } = await completedPayment(1_250_000);

    const res = await api(app, photographer).get('/api/analytics/summary?period=all').expect(200);
    const data = body<{ revenue: { receivedMinor: number; transactions: number } }>(res);

    expect(data.revenue.receivedMinor).toBe(amountMinor);
    expect(data.revenue.transactions).toBe(1);
  });

  it('summary excludes a failed payment from revenue', async () => {
    const { photographer, client, bookingId } = await approveBooking(app);
    await PaymentModel.create({
      reference: `TEST-FAIL-${bookingId.slice(-6)}`,
      bookingId,
      clientId: tenantIdFor(client),
      photographerId: tenantIdFor(photographer),
      provider: 'manual',
      transactionId: `test-fail-${bookingId.slice(-6)}`,
      amountMinor: 900_000,
      currency: 'NPR',
      paymentType: 'deposit',
      status: 'failed',
      verifiedAt: null,
    });

    const res = await api(app, photographer).get('/api/analytics/summary?period=all').expect(200);
    const data = body<{ revenue: { receivedMinor: number; transactions: number } }>(res);

    expect(data.revenue.receivedMinor).toBe(0);
    expect(data.revenue.transactions).toBe(0);
  });

  it('the grouped revenue series returns the same total as the summary', async () => {
    const { photographer, amountMinor } = await completedPayment(750_000);

    const res = await api(app, photographer).get('/api/analytics/revenue?period=all&groupBy=day').expect(200);
    const data = body<{ series: { period: string; minor: number }[]; totalMinor: number }>(res);

    expect(data.totalMinor).toBe(amountMinor);
    expect(data.series.length).toBeGreaterThan(0);
    // The row key is derived from `verifiedAt`; grouping on `paidAt` produced
    // rows whose key was the literal string "null".
    expect(data.series[0].period).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(data.series.reduce((sum, row) => sum + row.minor, 0)).toBe(amountMinor);
  });

  it('the admin overview picks up completed revenue too', async () => {
    const { amountMinor } = await completedPayment(400_000);
    const superadmin = await registerSuperAdmin(app);

    // Platform-wide, but still windowed to the last 30 days; the payment's
    // `verifiedAt` is "now", so it falls inside that window.
    const res = await api(app, superadmin).get('/api/admin/overview').expect(200);
    const data = body<{ revenue: { last30DaysMinor: number; transactions: number } }>(res);

    expect(data.revenue.last30DaysMinor).toBe(amountMinor);
    expect(data.revenue.transactions).toBe(1);
  });
});
