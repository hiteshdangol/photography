import type { Application } from 'express';
import request from 'supertest';
import { UserModel } from '../../models/User.js';
import { hashPassword } from '../../services/auth.service.js';

export interface TestUser {
  id: string;
  email: string;
  accessToken: string;
  role: 'photographer' | 'client' | 'superadmin';
}

export interface AuthSession {
  user: TestUser;
  refreshCookie: string;
  agent: ReturnType<typeof request.agent>;
}

const PASSWORD = 'TestPassw0rd!pass';

let sequence = 0;
function uniqueEmail(prefix: string): string {
  sequence += 1;
  return `${prefix}.${sequence}.${Date.now()}@example.test`;
}

/** Unwraps the `{ success, message, data }` envelope used by every endpoint. */
export function body<T>(res: request.Response): T {
  return res.body.data as T;
}

/**
 * Registers a user and returns a supertest agent holding the refresh cookie,
 * so cookie-authenticated flows (POST /auth/refresh) can be exercised too.
 */
export async function register(
  app: Application,
  role: 'photographer' | 'client' = 'photographer',
  overrides: { email?: string; name?: string } = {},
): Promise<AuthSession> {
  const email = overrides.email ?? uniqueEmail(role);
  const agent = request.agent(app);

  const res = await agent.post('/api/auth/register').send({
    email,
    password: PASSWORD,
    name: overrides.name ?? `Test ${role}`,
    role,
  });

  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`register failed (${res.status}): ${JSON.stringify(res.body)}`);
  }

  // `publicUser` exposes the id as `id`, never `_id`, on every auth response.
  const data = body<{ user: { id: string; email: string; role: TestUser['role'] }; accessToken: string }>(res);
  if (!data.user?.id) {
    throw new Error(`register response had no user id: ${JSON.stringify(res.body)}`);
  }

  const cookies = res.headers['set-cookie'];
  const refreshCookie = Array.isArray(cookies) ? cookies.join('; ') : (cookies ?? '');

  return {
    user: { id: data.user.id, email: data.user.email, accessToken: data.accessToken, role: data.user.role },
    refreshCookie,
    agent,
  };
}

/** Creates a photographer plus a client, the pairing almost every test needs. */
export async function registerPair(app: Application): Promise<{
  photographer: AuthSession;
  client: AuthSession;
}> {
  const photographer = await register(app, 'photographer');
  const client = await register(app, 'client');
  return { photographer, client };
}

/**
 * Returns a session for a superadmin.
 *
 * `POST /auth/register` accepts only `photographer` and `client` -- letting the
 * public form mint a `superadmin` would be a privilege-escalation hole -- so the
 * account is created directly and then authenticated through the real login
 * route. That still exercises real token signing, so `requireSuperAdmin` sees
 * exactly what it sees in production.
 */
export async function registerSuperAdmin(app: Application): Promise<AuthSession> {
  const email = uniqueEmail('superadmin');
  // There is no pre-save hook: `User.password` is always a bcrypt hash, so it
  // has to be hashed here exactly as `authService.register` does.
  await UserModel.create({
    name: 'Test Superadmin',
    email,
    password: await hashPassword(PASSWORD),
    role: 'superadmin',
    emailVerified: true,
  });

  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/login')
    .send({ email, password: PASSWORD })
    .expect(200);

  const data = body<{ user: { id: string; email: string; role: TestUser['role'] }; accessToken: string }>(res);
  if (!data.user?.id) {
    throw new Error(`superadmin login had no user id: ${JSON.stringify(res.body)}`);
  }

  const cookies = res.headers['set-cookie'];
  return {
    user: { id: data.user.id, email: data.user.email, accessToken: data.accessToken, role: data.user.role },
    refreshCookie: Array.isArray(cookies) ? cookies.join('; ') : (cookies ?? ''),
    agent,
  };
}

/**
 * A supertest agent with the session's bearer token already applied.
 *
 * `request(app)` returns a bare request factory with no `.set`, so an agent is
 * required here.
 */
export function api(app: Application, session: AuthSession): request.Agent {
  return request.agent(app).set('Authorization', `Bearer ${session.user.accessToken}`);
}

export { PASSWORD as TEST_PASSWORD };

/** The photographer's user id, which is what `photographerId` expects on a booking. */
export function tenantIdFor(session: AuthSession): string {
  return session.user.id;
}

/**
 * Opens the photographer's calendar.
 *
 * A newly registered photographer has *no* availability rules, so every slot
 * reads as `outside_working_hours` until they publish hours. Any test that
 * expects a booking to succeed must call this first.
 */
export async function openWorkingHours(
  app: Application,
  photographer: AuthSession,
  windows: { start: string; end: string }[] = [{ start: '09:00', end: '17:00' }],
): Promise<void> {
  for (let dayOfWeek = 0; dayOfWeek <= 6; dayOfWeek += 1) {
    await api(app, photographer)
      .put(`/api/availability/rules/${dayOfWeek}`)
      .send({ windows })
      .expect(200);
  }
}

/** Builds a request inside working hours (10:00-12:00) on a future date. */
export function workingSlot(daysFromNow = 14): { eventDate: string; startTime: string; endTime: string } {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  return {
    eventDate: date.toISOString().slice(0, 10),
    startTime: '10:00',
    endTime: '12:00',
  };
}

/** A slot guaranteed to be outside any sane working day (02:00-03:00). */
export function outsideWorkingSlot(daysFromNow = 14): { eventDate: string; startTime: string; endTime: string } {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  return {
    eventDate: date.toISOString().slice(0, 10),
    startTime: '02:00',
    endTime: '03:00',
  };
}

export interface ApprovedBooking {
  photographer: AuthSession;
  client: AuthSession;
  bookingId: string;
  /** Created by the approval. */
  projectId: string;
  /** Opened explicitly below; approval does not start a thread. */
  conversationId: string;
}

/**
 * Drives the full booking lifecycle and returns the records that approval
 * creates. There is no direct "create project" or "create conversation" route:
 * both are side effects of approving a booking, so tests that need a project or
 * a chat thread have to come through here.
 */
export async function approveBooking(
  app: Application,
  daysFromNow = 15,
): Promise<ApprovedBooking> {
  const { photographer, client } = await registerPair(app);
  await openWorkingHours(app, photographer);
  const slot = workingSlot(daysFromNow);

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

  // POST /:id/approve answers 200 (it also *creates* the project, but the route
  // uses `ok()` rather than `created()`).
  const approved = await api(app, photographer).post(`/api/bookings/${bookingId}/approve`).send({});
  if (approved.status !== 200) {
    throw new Error(`approve failed (${approved.status}): ${JSON.stringify(approved.body)}`);
  }

  const detail = await api(app, photographer).get(`/api/bookings/${bookingId}`).expect(200);
  const { project } = body<{ project: { _id: string } | null }>(detail);
  if (!project) throw new Error('approval did not create a project');

  /* No relationship-linking call here: `POST /api/bookings/request` already
   * records the pair, so reaching a 201 below is itself the regression test. */
  const started = await api(app, client)
    .post('/api/chat/conversations')
    .send({ recipientId: photographer.user.id, projectId: project._id })
    .expect(201);

  const { conversation } = body<{ conversation: { id: string } }>(started);
  if (!conversation?.id) throw new Error(`could not open a conversation: ${JSON.stringify(started.body)}`);

  return { photographer, client, bookingId, projectId: project._id, conversationId: conversation.id };
}
