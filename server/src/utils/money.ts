import { DEFAULT_CURRENCY_SYMBOLS } from '../config/categories.js';
import { env } from '../config/env.js';
import { ApiError } from './ApiError.js';

/**
 * All monetary amounts are stored as integer minor units (paisa / cents).
 * Floating point is never used for money anywhere in the codebase.
 */
export type Minor = number;

export function toMinor(major: number): Minor {
  if (!Number.isFinite(major)) throw ApiError.badRequest('Invalid amount.');
  return Math.round(major * 100);
}

export function toMajor(minor: Minor): number {
  return Math.round(minor) / 100;
}

export function sumMinor(values: Minor[]): Minor {
  return values.reduce((total, value) => total + Math.round(value), 0);
}

/**
 * A deposit can be a percentage of the total, a fixed amount, the whole thing,
 * or waived entirely (`'none'`, meaning the booking requires no deposit).
 *
 * `'none'` is a real stored value on Booking, Package and PhotographerProfile -
 * a studio that never asks for a deposit has to be able to say so - and it
 * resolves to zero rather than falling through to an error.
 */
export type DepositType = 'percent' | 'fixed' | 'full' | 'none';

export function computeDeposit(
  totalMinor: Minor,
  depositType: DepositType,
  depositValue: number,
): Minor {
  switch (depositType) {
    case 'none':
      return 0;
    case 'full':
      return totalMinor;
    case 'percent': {
      const percent = Math.min(Math.max(depositValue, 0), 100);
      return Math.round((totalMinor * percent) / 100);
    }
    case 'fixed':
      return Math.min(Math.max(Math.round(depositValue * 100), 0), totalMinor);
    default:
      return 0;
  }
}

export function currencySymbol(code = env.CURRENCY): string {
  return DEFAULT_CURRENCY_SYMBOLS[code] ?? code;
}

export function formatMoney(minor: Minor, code = env.CURRENCY): string {
  const value = new Intl.NumberFormat('en-NP', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(toMajor(minor));
  return `${currencySymbol(code)} ${value}`;
}
