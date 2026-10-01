import { env } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './config/db.js';
import { startCron, stopCron, listJobs } from './services/jobs/cron.js';
import { warmStorage } from './app.js';
import { createLogger } from './utils/logger.js';

/**
 * The scheduler process.
 *
 * `CRON_IN_API=false` stops the API from running cron, which is what you want
 * once there is more than one API replica -- otherwise every replica runs every
 * job. This process is the counterpart: it owns the database connection and the
 * job timers, and serves no HTTP traffic.
 *
 * It does not listen on a port and holds no sockets, so a supervisor (systemd,
 * Docker, PM2) should restart it if it exits.
 */
const log = createLogger('worker');

async function main(): Promise<void> {
  if (!env.CRON_ENABLED) {
    log.warn('CRON_ENABLED is false; the worker has nothing to do. Exiting.');
    process.exit(0);
  }

  /* Jobs touch storage (report exports, mail spooling), so the directories have
   * to exist before the first tick rather than failing inside a job. */
  warmStorage();
  await connectDatabase();

  startCron();
  log.info(`LensFlow worker up, running ${listJobs().length} jobs`, {
    jobs: listJobs().map((job) => `${job.name}/${Math.round(job.everyMs / 1000)}s`),
  });

  const shutdown = async (signal: string) => {
    log.info(`${signal} received, stopping worker`);
    stopCron();
    await disconnectDatabase();
    process.exit(0);
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
  log.error('worker failed to start', {
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
