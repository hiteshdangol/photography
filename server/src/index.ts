import http from 'node:http';
import { createApp, warmStorage } from './app.js';
import { env } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { createSocketServer } from './sockets/io.js';
import { startCron, stopCron } from './services/jobs/cron.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('boot');

async function main(): Promise<void> {
  warmStorage();
  await connectDatabase();

  const app = createApp();
  const server = http.createServer(app);
  createSocketServer(server);

  if (env.CRON_ENABLED && env.CRON_IN_API && !env.isTest) {
    startCron();
  } else if (env.CRON_ENABLED && !env.isTest) {
    log.info('CRON_IN_API is false; cron runs in the worker process (npm run worker)');
  }

  server.listen(env.PORT, () => {
    log.info(`LensFlow API listening on http://localhost:${env.PORT}${env.API_PREFIX}`);
    log.info(`Allowed client origin: ${env.CLIENT_URL}`);
    if (env.effectivePaymentProvider !== env.PAYMENT_PROVIDER) {
      log.warn(
        `PAYMENT_PROVIDER=${env.PAYMENT_PROVIDER} but credentials are missing; using the mock provider.`,
      );
    }
    if (!env.hasEmailTransport) {
      log.warn('SMTP is not configured - emails are written to server/uploads/mail/*.eml');
    }
  });

  const shutdown = async (signal: string) => {
    log.info(`${signal} received, shutting down`);
    stopCron();
    server.close(async () => {
      await disconnectDatabase();
      process.exit(0);
    });
    // Do not let a stuck connection hold the process open forever.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', { reason: String(reason) });
  });
  process.on('uncaughtException', (error) => {
    log.error('uncaught exception', { message: error.message, stack: error.stack });
  });
}

main().catch((error) => {
  log.error('failed to start', { message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
