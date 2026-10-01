import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Route params as they are actually used here: a single string per segment.
 *
 * Express's own `ParamsDictionary` types values as `string | string[]` because of
 * wildcards, which would force a cast at every `req.params.id` call site. Route
 * paths in this API never use wildcards, so handlers get the narrow type and the
 * wrappers below cast back to the generic `RequestHandler` Express expects.
 */
export type RouteParams = Record<string, string>;

export type AppRequest = Request<RouteParams>;

/** A handler that returns a promise, with concrete route params. */
export type AsyncRoute = (req: AppRequest, res: Response, next: NextFunction) => Promise<unknown>;

/**
 * Express 5 forwards rejected promises from handlers to the error middleware
 * automatically, but wrapping keeps the behaviour explicit and independent of
 * that version detail.
 */
export function asyncHandler(handler: AsyncRoute): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req as AppRequest, res, next)).catch(next);
  };
}
