import type { z, ZodError, ZodType } from 'zod';

/** An error that is safe to show the user. Anything else becomes a generic 500. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly isOperational: boolean;

  constructor(status: number, message: string, code = 'error', details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.isOperational = true;
  }

  static badRequest(message = 'Bad request.', details?: unknown) {
    return new ApiError(400, message, 'bad_request', details);
  }
  static validation(message = 'Please check the highlighted fields.', details?: unknown) {
    return new ApiError(422, message, 'validation_error', details);
  }
  static unauthorized(message = 'You must be signed in to do that.') {
    return new ApiError(401, message, 'unauthenticated');
  }
  static forbidden(message = 'You are not authorized to perform this action.') {
    return new ApiError(403, message, 'forbidden');
  }
  static notFound(message = 'We could not find what you were looking for.') {
    return new ApiError(404, message, 'not_found');
  }
  static conflict(message = 'That conflicts with the current state.', details?: unknown) {
    return new ApiError(409, message, 'conflict', details);
  }
  static payloadTooLarge(message = 'That file is too large.') {
    return new ApiError(413, message, 'payload_too_large');
  }
  static unsupportedMedia(message = 'That file type is not supported.') {
    return new ApiError(415, message, 'unsupported_media_type');
  }
  static tooManyRequests(message = 'Too many requests. Please slow down.') {
    return new ApiError(429, message, 'too_many_requests');
  }
  static internal(message = 'Something went wrong on our end.') {
    return new ApiError(500, message, 'internal_error');
  }
  static serviceUnavailable(message = 'This feature is temporarily unavailable.') {
    return new ApiError(503, message, 'service_unavailable');
  }
}

export function formatZodError(error: ZodError): { field: string; message: string }[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '_',
    message: issue.message,
  }));
}

export function validate<T extends ZodType>(schema: T, data: unknown): z.output<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw ApiError.validation('Please check the highlighted fields.', formatZodError(result.error));
  }
  return result.data as z.output<T>;
}
