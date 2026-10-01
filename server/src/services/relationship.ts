import type { Types } from 'mongoose';
import { ClientProfileModel } from '../models/index.js';

/**
 * The client/photographer relationship.
 *
 * `ClientProfile.photographerIds` is the single source of truth for "may these
 * two people talk to each other". Chat reads it on every conversation start, and
 * it also scopes a photographer's client list.
 *
 * It used to be written in exactly one place -- the private-notes upsert -- which
 * meant a client who booked and got approved but never had a note saved could not
 * open a conversation with the photographer they had just hired. Every path that
 * creates an engagement must link the pair through here instead.
 *
 * `$addToSet` makes this safe to call repeatedly, and `upsert` repairs a profile
 * that was never provisioned.
 */
export async function linkClientToPhotographer(
  clientId: Types.ObjectId,
  photographerId: Types.ObjectId,
): Promise<void> {
  await ClientProfileModel.updateOne(
    { userId: clientId },
    { $addToSet: { photographerIds: photographerId } },
    { upsert: true, setDefaultsOnInsert: true },
  );
}
