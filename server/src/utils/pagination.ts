import { env } from '../config/env.js';
import { ApiError } from './ApiError.js';
import type { Request } from 'express';

export interface Pagination {
  page: number;
  limit: number;
  skip: number;
}

export interface Paginated<T> {
  items: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

export function parsePagination(query: Request['query']): Pagination {
  const page = Math.max(1, Number(query.page) || 1);
  const requested = Number(query.limit) || 24;
  const limit = Math.min(Math.max(1, requested), env.MAX_PAGE_SIZE);
  return { page, limit, skip: (page - 1) * limit };
}

export function paginated<T>(items: T[], total: number, { page, limit }: Pagination): Paginated<T> {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };
}

/** Cursor pagination for photo lists, where offset pagination gets slow. */
export function parseCursor(query: Request['query']): { cursor?: string; limit: number } {
  const limit = Math.min(Math.max(1, Number(query.limit) || 48), 200);
  const cursor = typeof query.cursor === 'string' && query.cursor.length > 0 ? query.cursor : undefined;
  return { cursor, limit };
}

export function decodeCursor(cursor: string | undefined): { createdAt?: Date; id?: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      c?: string;
      i?: string;
    };
    if (!parsed.c) return null;
    const createdAt = new Date(parsed.c);
    if (Number.isNaN(createdAt.getTime())) throw new Error('bad date');
    return { createdAt, id: parsed.i };
  } catch {
    throw ApiError.badRequest('Invalid pagination cursor.');
  }
}

export function encodeCursor(doc: { createdAt: Date; _id: unknown }): string {
  return Buffer.from(JSON.stringify({ c: doc.createdAt.toISOString(), i: String(doc._id) })).toString(
    'base64url',
  );
}
