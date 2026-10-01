import { Types } from 'mongoose';
import { AvailabilityBlockModel, AvailabilityRuleModel, BookingModel } from '../models/index.js';
import { ApiError } from '../utils/ApiError.js';
import { BOOKING_ERRORS } from '../messages.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('availability');

export const MIN_LEAD_MINUTES = 60;

export interface TimeRange {
  start: string;
  end: string;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function fromMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function rangesOverlap(a: TimeRange, b: TimeRange): boolean {
  return toMinutes(a.start) < toMinutes(b.end) && toMinutes(b.start) < toMinutes(a.end);
}

/** `YYYY-MM-DD` in UTC, matching how event dates are stored. */
export function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface DayAvailability {
  date: string;
  available: boolean;
  windows: TimeRange[];
  reason?: 'past' | 'blocked' | 'outside_working_hours' | 'fully_booked' | 'lead_time';
  conflicts: { start: string; end: string; bookingId: string }[];
}

async function workingWindows(photographerId: Types.ObjectId, date: Date): Promise<TimeRange[]> {
  const rule = await AvailabilityRuleModel.findOne({
    photographerId,
    dayOfWeek: date.getUTCDay(),
    active: true,
  }).lean();
  if (!rule) return [];
  return (rule.windows ?? []) as TimeRange[];
}

async function blockedWindows(
  photographerId: Types.ObjectId,
  date: Date,
): Promise<{ allDay: boolean; windows: TimeRange[]; reason: string }[]> {
  const blocks = await AvailabilityBlockModel.find({
    photographerId,
    startDate: { $lte: date },
    endDate: { $gte: date },
  }).lean();
  return blocks.map((b) => ({
    allDay: b.allDay,
    windows: (b.windows ?? []) as TimeRange[],
    reason: b.reason,
  }));
}

async function bookedWindows(
  photographerId: Types.ObjectId,
  date: Date,
  ignoreBookingId?: string,
): Promise<{ start: string; end: string; bookingId: string }[]> {
  const dayStart = new Date(`${dateKey(date)}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const bookings = await BookingModel.find({
    photographerId,
    eventDate: { $gte: dayStart, $lt: dayEnd },
    status: { $in: ['pending', 'approved'] },
    // The booking being re-validated (approve / reschedule) must not count as a
    // conflict against itself.
    ...(ignoreBookingId && Types.ObjectId.isValid(ignoreBookingId)
      ? { _id: { $ne: new Types.ObjectId(ignoreBookingId) } }
      : {}),
  })
    .select('_id startTime endTime')
    .lean();
  return bookings.map((b) => ({
    start: b.startTime,
    end: b.endTime,
    bookingId: String(b._id),
  }));
}

function subtract(base: TimeRange[], blocks: TimeRange[]): TimeRange[] {
  let result = base.map((w) => ({ ...w }));
  for (const block of blocks) {
    const next: TimeRange[] = [];
    for (const window of result) {
      if (!rangesOverlap(window, block)) {
        next.push(window);
        continue;
      }
      const blockStart = toMinutes(block.start);
      const blockEnd = toMinutes(block.end);
      if (toMinutes(window.start) < blockStart) {
        next.push({ start: window.start, end: block.start });
      }
      if (toMinutes(window.end) > blockEnd) {
        next.push({ start: block.end, end: window.end });
      }
    }
    result = next;
  }
  return result.filter((w) => toMinutes(w.end) > toMinutes(w.start));
}

/**
 * Availability for a single day. This is what the client's calendar renders.
 *
 * `pending` bookings count as busy: a photographer who has a request in for a
 * slot should not be able to sell the same slot twice while they think about it.
 */
export async function dayAvailability(
  photographerId: Types.ObjectId | string,
  date: Date,
  options: { ignoreBookingId?: string } = {},
): Promise<DayAvailability> {
  const pid = new Types.ObjectId(String(photographerId));
  const key = dateKey(date);
  const now = new Date();

  const dayStart = new Date(`${key}T00:00:00.000Z`);
  if (dayStart.getTime() < now.getTime() - 24 * 60 * 60 * 1000) {
    return { date: key, available: false, windows: [], reason: 'past', conflicts: [] };
  }

  const working = await workingWindows(pid, date);
  if (working.length === 0) {
    return { date: key, available: false, windows: [], reason: 'outside_working_hours', conflicts: [] };
  }

  const blocks = await blockedWindows(pid, date);
  const allDayBlock = blocks.find((b) => b.allDay);
  if (allDayBlock) {
    return { date: key, available: false, windows: [], reason: 'blocked', conflicts: [] };
  }

  const booked = await bookedWindows(pid, date, options.ignoreBookingId);
  let free = subtract(working, blocks.flatMap((b) => b.windows));
  free = subtract(free, booked.map((b) => ({ start: b.start, end: b.end })));

  // Enforce minimum lead time by trimming the start of the earliest window.
  const leadCutoff = new Date(now.getTime() + MIN_LEAD_MINUTES * 60 * 1000);
  if (leadCutoff > dayStart && leadCutoff < new Date(dayStart.getTime() + 24 * 60 * 60 * 1000)) {
    const cutoffMinutes =
      leadCutoff.getUTCHours() * 60 + leadCutoff.getUTCMinutes() - dayStart.getUTCHours() * 60 - dayStart.getUTCMinutes();
    free = free
      .map((w) => (toMinutes(w.start) < cutoffMinutes ? { start: fromMinutes(cutoffMinutes), end: w.end } : w))
      .filter((w) => toMinutes(w.end) > toMinutes(w.start));
    if (free.length === 0) {
      return { date: key, available: false, windows: [], reason: 'lead_time', conflicts: booked };
    }
  }

  return { date: key, available: free.length > 0, windows: free, conflicts: booked };
}

export interface RangeCheck {
  available: boolean;
  reason?: string;
  conflict?: { bookingId: string; start: string; end: string };
}

/**
 * Authoritative availability check.
 *
 * The frontend uses the same code to grey out slots, but this is the version
 * that decides: it runs on every booking create, approve and reschedule, and
 * `confirmBooking` re-runs it inside the write path. A client that skips the
 * UI check entirely still cannot double-book.
 */
export async function assertSlotAvailable(
  photographerId: Types.ObjectId | string,
  eventDate: Date,
  startTime: string,
  endTime: string,
  options: { ignoreBookingId?: string } = {},
): Promise<RangeCheck> {
  const pid = new Types.ObjectId(String(photographerId));
  const requested: TimeRange = { start: startTime, end: endTime };

  if (toMinutes(endTime) <= toMinutes(startTime)) {
    return { available: false, reason: 'end_time_before_start' };
  }

  // `ignoreBookingId` has to be applied *here*, before the window-fit test.
  // `dayAvailability` subtracts booked ranges from the free windows, so without
  // this the booking being approved removes its own slot and no longer fits in
  // any window, making every approve fail with `outside_working_hours`.
  const day = await dayAvailability(pid, eventDate, { ignoreBookingId: options.ignoreBookingId });
  if (!day.available) {
    return { available: false, reason: day.reason ?? 'unavailable' };
  }

  const fitsInAWorkingWindow = day.windows.some(
    (w) => toMinutes(w.start) <= toMinutes(startTime) && toMinutes(endTime) <= toMinutes(w.end),
  );
  if (!fitsInAWorkingWindow) {
    return { available: false, reason: 'outside_working_hours' };
  }

  if (options.ignoreBookingId) {
    return { available: true };
  }

  // Final, explicit overlap check against confirmed and pending bookings.
  const dayStart = new Date(`${dateKey(eventDate)}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const conflicts = await BookingModel.find({
    photographerId: pid,
    eventDate: { $gte: dayStart, $lt: dayEnd },
    status: { $in: ['pending', 'approved'] },
  })
    .select('_id startTime endTime')
    .lean();

  for (const booking of conflicts) {
    if (rangesOverlap(requested, { start: booking.startTime, end: booking.endTime })) {
      return {
        available: false,
        reason: 'slot_taken',
        conflict: {
          bookingId: String(booking._id),
          start: booking.startTime,
          end: booking.endTime,
        },
      };
    }
  }

  return { available: true };
}

/** Throws a 409 with a client-friendly message when a slot is taken. */
export async function assertBookable(
  photographerId: Types.ObjectId | string,
  eventDate: Date,
  startTime: string,
  endTime: string,
  options: { ignoreBookingId?: string } = {},
): Promise<void> {
  const result = await assertSlotAvailable(photographerId, eventDate, startTime, endTime, options);
  if (!result.available) {
    log.info('blocked booking', { photographerId: String(photographerId), date: dateKey(eventDate), startTime, reason: result.reason });
    throw ApiError.conflict(BOOKING_ERRORS.slotTaken, { reason: result.reason });
  }
}

/** Range summary for the calendar: one entry per day, only what the client needs. */
export async function rangeAvailability(
  photographerId: Types.ObjectId | string,
  from: Date,
  to: Date,
): Promise<DayAvailability[]> {
  const out: DayAvailability[] = [];
  const cursor = new Date(`${dateKey(from)}T00:00:00.000Z`);
  const end = new Date(`${dateKey(to)}T00:00:00.000Z`);
  // Hard cap so a wide range query cannot be used to hammer the API.
  const maxDays = 120;
  let guard = 0;

  while (cursor <= end && guard < maxDays) {
    out.push(await dayAvailability(photographerId, cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    guard += 1;
  }
  return out;
}
