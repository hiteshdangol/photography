/**
 * Global test setup.
 *
 * Every suite gets its own in-memory MongoDB (see `fileParallelism: false` plus
 * `pool: 'forks'` in vitest.config.ts), so suites can never see each other's
 * data and nothing here touches a real database.
 *
 * The env vars below MUST be assigned before anything imports `config/env.js`,
 * because that module parses `process.env` at import time and calls
 * `process.exit(1)` on failure. Static `import` statements are hoisted above
 * top-level statements, so the database module is pulled in dynamically below.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.CRON_ENABLED = 'false';
process.env.DB_STRICT = 'false';
process.env.STORAGE_DRIVER = 'local';

/* bcrypt at 12 rounds dominates the runtime of every auth test. */
process.env.BCRYPT_ROUNDS = '4';

/* Deterministic 32-byte secrets; the length minimum is the only real rule. */
process.env.JWT_SECRET ??= 'test-access-secret-do-not-use-anywhere-else';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-do-not-use-anywhere-else';

import { afterAll, beforeAll, afterEach } from 'vitest';
import type { Server } from 'node:http';
import mongoose from 'mongoose';
import type { Application } from 'express';
import type { TypedIoServer } from '../sockets/emitter.js';

/**
 * Type-only handle on the db module.
 *
 * `db.js` reads `env.MONGO_URI` at module scope, and this file has to set the
 * unreachable test URI *before* that happens -- so the value is imported
 * dynamically inside `beforeAll`. Only `connectDatabase` is used, so that is all
 * that needs a type.
 */
type ConnectDatabase = typeof import('../config/db.js')['connectDatabase'];

let connectDatabase: ConnectDatabase;
let disconnectDatabase: typeof import('../config/db.js')['disconnectDatabase'];
let httpServer: Server;
let io: TypedIoServer;
let app: Application;

beforeAll(async () => {
  /* Deliberately unreachable so connectDatabase() takes its in-memory fallback
   * rather than attaching to a real MongoDB. This must be set *before* the
   * dynamic imports below: config/env.js parses process.env at import time, so
   * assigning it afterwards would leave the tests pointed at the developer's
   * actual .env database and quietly write rows into it. */
  process.env.MONGO_URI = 'mongodb://127.0.0.1:1/lensflow-test-unreachable';
  process.env.DB_STRICT = 'false';

  const db = await import('../config/db.js');
  const { createApp } = await import('../app.js');
  const { createSocketServer } = await import('../sockets/io.js');

  connectDatabase = db.connectDatabase;
  disconnectDatabase = db.disconnectDatabase;
  await connectDatabase();

  app = createApp();
  httpServer = await new Promise<Server>((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });

  /* Mirrors production wiring: Socket.IO must be attached to the HTTP server. */
  io = createSocketServer(httpServer);
});

afterEach(async () => {
  if (mongoose.connection.readyState !== 1) return;

  const collections = await mongoose.connection.db?.collections() ?? [];
  await Promise.all(
    collections
      .filter((c) => !c.collectionName.startsWith('system.'))
      .map((c) => c.deleteMany({})),
  );
});

afterAll(async () => {
  io?.close();
  if (httpServer?.listening) {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
  await disconnectDatabase?.();
});

/** The ephemeral port the test server actually bound to. */
function testPort(): number {
  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('test http server is not bound to a TCP port');
  }
  return address.port;
}

export { app, io, httpServer, testPort };
