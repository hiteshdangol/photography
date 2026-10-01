import type { Types } from 'mongoose';
import { PackageModel, PhotographerProfileModel, ServiceModel } from '../models/index.js';

/**
 * Keep the directory's "Starting from" figure in sync with the cheapest active
 * package *and* the cheapest active service, so whichever list the photographer
 * edits, the profile reflects the true entry price.
 */
export async function refreshStartingPrice(photographerId: Types.ObjectId): Promise<void> {
  const [cheapestPackage, cheapestService] = await Promise.all([
    PackageModel.findOne({ photographerId, active: true }).sort({ price: 1 }).select('price').lean(),
    ServiceModel.findOne({ photographerId, active: true, basePrice: { $gt: 0 } })
      .sort({ basePrice: 1 })
      .select('basePrice')
      .lean(),
  ]);

  const candidates = [cheapestPackage?.price, cheapestService?.basePrice].filter(
    (value): value is number => typeof value === 'number' && value > 0,
  );
  const startingPrice = candidates.length ? Math.min(...candidates) : 0;
  await PhotographerProfileModel.updateOne({ userId: photographerId }, { $set: { startingPrice } });
}
