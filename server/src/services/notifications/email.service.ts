import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';
import { UPLOAD_ROOT } from '../../config/env.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('mail');

/**
 * Email delivery with a local-first development mode.
 *
 * With no SMTP credentials configured, every message is written to
 * `server/uploads/mail/*.eml` and logged. That keeps the notification pipeline
 * (notifications -> dispatcher -> channel) fully exercised locally without
 * requiring a mailbox, and means the exact same code path runs in production.
 */
let transporter: Transporter | null = null;
const MAIL_DIR = path.join(UPLOAD_ROOT, 'mail');

function hasSmtp(): boolean {
  return Boolean(process.env.EMAIL_HOST && process.env.EMAIL_USER);
}

function getTransporter(): Transporter {
  if (transporter) return transporter;
  if (hasSmtp()) {
    transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: Number(process.env.EMAIL_PORT ?? 587),
      secure: process.env.EMAIL_SECURE === 'true',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD },
    });
    log.info('using SMTP transport', { host: process.env.EMAIL_HOST });
  } else {
    // JSON transport: no network, and the payload is inspectable in tests.
    transporter = nodemailer.createTransport({ jsonTransport: true });
    log.info('SMTP not configured - emails will be written to uploads/mail');
  }
  return transporter;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

async function writeToDisk(message: MailMessage): Promise<void> {
  await fsp.mkdir(MAIL_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeTo = message.to.replace(/[^a-z0-9@._-]/gi, '_');
  const file = path.join(MAIL_DIR, `${stamp}_${safeTo}.eml`);
  const body = [
    `From: ${process.env.EMAIL_FROM ?? 'LensFlow'}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    message.text,
  ].join('\r\n');
  await fsp.writeFile(file, body, 'utf8');
  log.info('email written to disk', { to: message.to, subject: message.subject, file });
}

export async function sendMail(message: MailMessage): Promise<{ delivered: boolean; error?: string }> {
  if (!hasSmtp()) {
    try {
      await writeToDisk(message);
      return { delivered: true };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log.warn('failed to persist email', { to: message.to, detail });
      return { delivered: false, error: detail };
    }
  }

  try {
    await getTransporter().sendMail({
      from: process.env.EMAIL_FROM ?? 'LensFlow <no-reply@lensflow.test>',
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    log.info('email sent', { to: message.to, subject: message.subject });
    return { delivered: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log.warn('email delivery failed', { to: message.to, subject: message.subject, detail });
    return { delivered: false, error: detail };
  }
}

export function mailDirectory(): string {
  return MAIL_DIR;
}

export function readMailbox(limit = 50): string[] {
  try {
    return fs
      .readdirSync(MAIL_DIR)
      .filter((f) => f.endsWith('.eml'))
      .sort()
      .reverse()
      .slice(0, limit);
  } catch {
    return [];
  }
}

export const emailTransport = {
  sendPasswordReset: async (to: string, token: string | null) => {
    const base = process.env.CLIENT_URL ?? 'http://localhost:5173';
    if (!token) {
      // Account does not exist; still return without sending.
      return { delivered: true };
    }
    return sendMail({
      to,
      subject: 'Reset your LensFlow password',
      text: [
        'We received a request to reset your LensFlow password.',
        '',
        `${base}/reset-password?token=${token}`,
        '',
        'This link expires in one hour. If you did not request this, you can ignore this email.',
      ].join('\n'),
    });
  },
};
