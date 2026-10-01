import express, { type Application, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { env } from './config/env.js';
import { databaseKind } from './config/db.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { globalLimiter } from './middleware/rateLimit.js';
import { sanitizeRequest } from './middleware/sanitize.js';
import { requestId } from './middleware/cookies.js';
import { ok } from './utils/response.js';
import { getStorage } from './services/storage/index.js';
import { readMailbox } from './services/notifications/email.service.js';
import { isIoReady } from './sockets/emitter.js';
import { env as cfg } from './config/env.js';

import authRoutes from './routes/auth.routes.js';
import photographerRoutes from './routes/photographer.routes.js';
import categoryRoutes from './routes/category.routes.js';
import contactRoutes from './routes/contact.routes.js';
import serviceRoutes from './routes/service.routes.js';
import packageRoutes from './routes/package.routes.js';
import availabilityRoutes from './routes/availability.routes.js';
import clientRoutes from './routes/client.routes.js';
import bookingRoutes from './routes/booking.routes.js';
import projectRoutes from './routes/project.routes.js';
import photoRoutes from './routes/photo.routes.js';
import albumRoutes from './routes/album.routes.js';
import favoriteRoutes from './routes/favorite.routes.js';
import selectionRoutes from './routes/selection.routes.js';
import commentRoutes from './routes/comment.routes.js';
import shareRoutes from './routes/share.routes.js';
import portfolioRoutes from './routes/portfolio.routes.js';
import paymentRoutes from './routes/payment.routes.js';
import invoiceRoutes from './routes/invoice.routes.js';
import chatRoutes from './routes/chat.routes.js';
import notificationRoutes from './routes/notification.routes.js';
import testimonialRoutes from './routes/testimonial.routes.js';
import adminRoutes from './routes/admin.routes.js';
import analyticsRoutes from './routes/analytics.routes.js';

/**
 * Builds the Express application.
 *
 * Exported separately from the HTTP listener so the test suite can mount it with
 * supertest against an in-memory database without opening a port.
 */
export function createApp(): Application {
  const app = express();

  // Required for correct client IPs (rate limiting) behind a reverse proxy.
  app.set('trust proxy', env.isProduction ? 1 : false);
  app.disable('x-powered-by');

  // --- security headers ----------------------------------------------------
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          // The SPA is served by Vite in dev and a static host in production;
          // inline styles are required by FullCalendar and the lightbox.
          'style-src': ["'self'", "'unsafe-inline'"],
          'script-src': ["'self'"],
          'img-src': ["'self'", 'data:', 'blob:'],
          'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
          'connect-src': ["'self'", ...env.corsOrigins, 'ws:', 'wss:'],
          'frame-src': ['https://web.esewa.com.np', 'https://checkout.khalti.com', 'https://test-pay.khalti.com'],
          'form-action': ["'self'", 'https://web.esewa.com.np', 'https://rc-epay.esewa.com.np'],
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
          'frame-ancestors': ["'none'"],
          ...(env.isProduction ? { 'upgrade-insecure-requests': [] } : {}),
        },
      },
      crossOriginEmbedderPolicy: false,
      // Private gallery images are streamed from this origin; other sites must
      // not be able to embed or hotlink them.
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      hsts: env.isProduction ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
    }),
  );

  // --- CORS ---------------------------------------------------------------
  // Exact-origin allowlist. Credentials are on because of the refresh cookie.
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) return callback(null, true); // curl / server-to-server
        if (env.corsOrigins.includes(origin)) return callback(null, true);
        return callback(new Error(`Origin ${origin} is not allowed by CORS.`));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id', 'Content-Disposition'],
      maxAge: 86400,
    }),
  );

  // --- core parsers --------------------------------------------------------
  app.use(requestId);
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(cookieParser());
  app.use(sanitizeRequest);
  app.use(globalLimiter);

  // --- health / diagnostics ------------------------------------------------
  app.get('/api/health', (_req: Request, res: Response) =>
    ok(res, {
      status: 'ok',
      environment: cfg.NODE_ENV,
      database: databaseKind(),
      realtime: isIoReady(),
      paymentProvider: cfg.effectivePaymentProvider,
      emailTransport: cfg.hasEmailTransport ? 'smtp' : 'filesystem',
      uptimeSeconds: Math.round(process.uptime()),
    }),
  );

  /** Dev-only: lists the .eml files written when SMTP is not configured. */
  app.get('/api/health/mailbox', (_req: Request, res: Response) => {
    if (env.isProduction) {
      res.status(404).json({ success: false, message: 'Not found.', code: 'not_found' });
      return;
    }
    ok(res, { messages: readMailbox(25) });
  });

  // --- API ----------------------------------------------------------------
  const api = express.Router();

  api.use('/auth', authRoutes);
  api.use('/categories', categoryRoutes);
  api.use('/contact', contactRoutes);
  api.use('/photographers', photographerRoutes);
  api.use('/services', serviceRoutes);
  api.use('/packages', packageRoutes);
  api.use('/availability', availabilityRoutes);
  api.use('/clients', clientRoutes);
  api.use('/bookings', bookingRoutes);
  api.use('/projects', projectRoutes);
  api.use('/photos', photoRoutes);
  api.use('/albums', albumRoutes);
  api.use('/favorites', favoriteRoutes);
  api.use('/selections', selectionRoutes);
  api.use('/comments', commentRoutes);
  api.use('/shares', shareRoutes);
  api.use('/portfolio', portfolioRoutes);
  api.use('/payments', paymentRoutes);
  api.use('/invoices', invoiceRoutes);
  api.use('/chat', chatRoutes);
  api.use('/notifications', notificationRoutes);
  api.use('/testimonials', testimonialRoutes);
  api.use('/analytics', analyticsRoutes);
  api.use('/admin', adminRoutes);

  app.use(env.API_PREFIX, api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/** Eagerly creates the upload directories so uploads never fail on a cold start. */
export function warmStorage(): void {
  getStorage();
}
