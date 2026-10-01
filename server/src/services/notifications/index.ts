import { sendMail } from './email.service.js';

export { emailTransport } from './email.service.js';

/**
 * Channel abstraction. Only in-app + email are implemented; SMS and WhatsApp
 * slots in here later without touching any caller.
 */
export const channels = {
  inApp: 'in-app',
  email: 'email',
  sms: 'sms',
  whatsapp: 'whatsapp',
} as const;

export type ChannelName = (typeof channels)[keyof typeof channels];

export { sendMail };
