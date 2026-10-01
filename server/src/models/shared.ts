import { Schema } from 'mongoose';
import type { Types } from 'mongoose';

/** `YYYY-MM-DDTHH:mm` in the photographer's local timezone (no zone suffix). */
export type LocalDateTimeString = string;

export interface AvailabilityWindow {
  start: string;
  end: string;
}

export interface RatingBreakdown {
  average: number;
  count: number;
}

export interface AddressParts {
  city?: string;
  area?: string;
  country?: string;
  lat?: number;
  lng?: number;
}

export interface MoneySnapshot {
  /** Integer minor units. */
  amount: number;
  currency: string;
}

export interface AuditFields {
  createdBy?: Types.ObjectId;
  updatedBy?: Types.ObjectId;
}

const ratingBreakdownSchema = new Schema<RatingBreakdown>(
  {
    average: { type: Number, default: 0, min: 0, max: 5 },
    count: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const addressSchema = new Schema<AddressParts>(
  {
    city: { type: String, trim: true },
    area: { type: String, trim: true },
    country: { type: String, trim: true, default: 'Nepal' },
    lat: Number,
    lng: Number,
  },
  { _id: false },
);

export { ratingBreakdownSchema, addressSchema };
