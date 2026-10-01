import mongoose from 'mongoose';
import { env } from './env.js';

let memoryServer: { stop: () => Promise<boolean> } | null = null;

mongoose.set('strictQuery', true);

/**
 * NoSQL-injection defence is handled by Zod, not by `sanitizeFilter`.
 *
 * `sanitizeFilter` wraps any object-shaped filter value in `$eq`, so legitimate
 * operator queries such as `{ status: { $in: [...] } }` or
 * `{ eventDate: { $lte: cutoff } }` become literal values and fail to cast. That
 * breaks every range and membership query in the app (the cron sweep and the
 * dashboard aggregations both threw at boot).
 *
 * We do not need it: `validateBody` / `validateQuery` / `validateParams` replace
 * the request with a Zod-parsed object, and because every schema is a plain
 * `z.object` (none use `.passthrough()`), unknown keys such as `$where` or
 * `{$ne: null}` are dropped before a controller can read them. Route filters are
 * then built field by field from those coerced values rather than by spreading
 * `req.body` / `req.query` into the filter, so a prototype-polluting or
 * operator-shaped key never reaches the driver.
 */

function log(level: 'info' | 'warn' | 'error', message: string, meta?: unknown) {
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`[db] ${message}`, meta ?? '');
}

/**
 * Connect to MongoDB.
 *
 * Development convenience: if MONGO_URI is unreachable and we are not in
 * production, fall back to an ephemeral in-process MongoDB so `npm run dev`
 * works on a machine with no database installed. Set DB_STRICT=true to opt out.
 */
export async function connectDatabase(): Promise<string> {
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection.name ?? 'connected';
  }

  const options = {
    serverSelectionTimeoutMS: 3000,
    maxPoolSize: 20,
    autoIndex: !env.isProduction,
  };

  try {
    await mongoose.connect(env.MONGO_URI, options);
    log('info', `connected to ${redactUri(env.MONGO_URI)}`);
    return mongoose.connection.name ?? 'connected';
  } catch (error) {
    if (env.DB_STRICT || env.isProduction) {
      log('error', `unable to connect to ${redactUri(env.MONGO_URI)}`, (error as Error).message);
      throw error;
    }

    log('warn', `could not reach ${redactUri(env.MONGO_URI)} - starting an in-memory MongoDB fallback.`);
    log('warn', 'Data will NOT persist between restarts. Install MongoDB or set DB_STRICT=true to stop this.');

    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const server = await MongoMemoryServer.create();
    memoryServer = server;
    await mongoose.connect(server.getUri('lensflow'), options);
    log('info', 'connected to in-memory MongoDB (development fallback)');
    return 'memory';
  }
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
}

export function databaseKind(): 'external' | 'memory' | 'disconnected' {
  if (memoryServer) return 'memory';
  if (mongoose.connection.readyState === 1) return 'external';
  return 'disconnected';
}

function redactUri(uri: string): string {
  return uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@');
}
