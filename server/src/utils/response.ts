import type { Response } from 'express';

export interface SuccessBody<T> {
  success: true;
  message: string;
  data: T;
  meta?: Record<string, unknown>;
}

/** Every successful response uses this shape, so the client has one contract. */
export function ok<T>(res: Response, data: T, message = 'Done.', meta?: Record<string, unknown>): Response {
  const body: SuccessBody<T> = { success: true, message, data };
  if (meta) body.meta = meta;
  return res.status(200).json(body);
}

export function created<T>(res: Response, data: T, message = 'Created.'): Response {
  return res.status(201).json({ success: true, message, data } satisfies SuccessBody<T>);
}

export function noContent(res: Response, message = 'Removed.'): Response {
  return res.status(200).json({ success: true, message, data: null });
}

/** Wraps an async handler so rejections reach the error middleware as ApiError. */
export function fail(message: string, code = 'error', status = 400): never {
  // Imported lazily to avoid a cycle between response helpers and ApiError.
  throw Object.assign(new Error(message), { status, code, isOperational: true });
}
