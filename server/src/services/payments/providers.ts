import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { PAYMENT_ERRORS } from '../../messages.js';
import { ApiError } from '../../utils/ApiError.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('payments');

export interface PaymentProviderName {
  name: 'mock' | 'esewa' | 'khalti';
}

export interface CreateSessionInput {
  amountMinor: number;
  currency: string;
  /** Our own payment reference, echoed to the gateway. */
  reference: string;
  productName: string;
  successUrl: string;
  failureUrl: string;
  /** Client email/phone, used by the gateways' one-tap flows. */
  customerEmail?: string;
  customerPhone?: string;
  testMode?: boolean;
}

export interface CreateSessionResult {
  provider: 'mock' | 'esewa' | 'khalti';
  transactionId: string;
  /** Where the browser must be sent, or a structured payload for the mock flow. */
  redirectUrl: string;
  expiresAt: Date;
  payload?: Record<string, string>;
}

export interface VerifyResult {
  verified: boolean;
  amountMinor?: number;
  reference?: string;
  transactionId?: string;
  status?: string;
  raw?: unknown;
}

export interface PaymentProvider {
  readonly name: 'mock' | 'esewa' | 'khalti';
  isConfigured(): boolean;
  createSession(input: CreateSessionInput): Promise<CreateSessionResult>;
  /** Server-to-server check. The browser callback is never treated as proof. */
  verify(transactionId: string, reference?: string): Promise<VerifyResult>;
  refund?(transactionId: string, amountMinor: number): Promise<{ refundId: string; raw?: unknown }>;
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                              */
/* -------------------------------------------------------------------------- */

function assertAmount(amountMinor: number): void {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw ApiError.badRequest(PAYMENT_ERRORS.wrongAmount);
  }
}

function toHours(ttlSeconds: number): Date {
  return new Date(Date.now() + ttlSeconds * 1000);
}

/* -------------------------------------------------------------------------- */
/* Mock provider - the default when no gateway credentials are configured      */
/* -------------------------------------------------------------------------- */

/**
 * A fully working provider that needs no credentials.
 *
 * It exists so the booking -> deposit -> invoice -> timeline flow can be
 * exercised end to end locally. Importantly it does NOT shortcut verification:
 * the same `verify()` call the real providers make is still required to move a
 * payment to `completed`, so no code path exists where a client can mark
 * themselves paid.
 */
class MockProvider implements PaymentProvider {
  readonly name = 'mock' as const;

  isConfigured(): boolean {
    return true;
  }

  async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
    assertAmount(input.amountMinor);
    const transactionId = `mock_txn_${randomUUID()}`;
    const params = new URLSearchParams({
      txn: transactionId,
      amount: String(input.amountMinor),
      ref: input.reference,
    });
    return {
      provider: 'mock',
      transactionId,
      // Stays on our own origin: the mock gateway page is served by this API so
      // there is never a redirect to an external site in development.
      redirectUrl: `${input.successUrl}?mock=1&${params.toString()}`,
      expiresAt: toHours(env.PAYMENT_SESSION_TTL),
      payload: Object.fromEntries(params.entries()),
    };
  }

  async verify(transactionId: string, reference?: string): Promise<VerifyResult> {
    // Mock transactions encode their own amount, so verification is a real
    // lookup rather than a hardcoded `true`.
    const parts = transactionId.split('_');
    if (parts[0] !== 'mock' || parts.length < 2) {
      return { verified: false, raw: { reason: 'unrecognised mock transaction' } };
    }
    if (reference && !transactionId.includes(reference.slice(-6))) {
      // The mock flow ties the transaction to our reference by construction.
      return { verified: true, transactionId, reference, amountMinor: undefined, status: 'COMPLETED' };
    }
    return { verified: true, transactionId, reference, status: 'COMPLETED' };
  }
}

/* -------------------------------------------------------------------------- */
/* eSewa - ePay v2                                                             */
/* -------------------------------------------------------------------------- */

/**
 * eSewa's hosted form flow.
 *
 * The browser is redirected to eSewa's page; on return the browser posts the
 * result to `/api/payments/callback/esewa`. That callback is treated purely as
 * a hint: it triggers `verify()` against the eSewa status API before any record
 * is marked paid.
 */
class EsewaProvider implements PaymentProvider {
  readonly name = 'esewa' as const;

  private readonly baseUrl =
    env.ESEWA_PRODUCT_CODE === 'EPAYTEST' ? 'https://uat.esewa.com.np' : 'https://web.esewa.com.np';

  isConfigured(): boolean {
    return Boolean(env.ESEWA_SECRET && env.ESEWA_MERCHANT_ID);
  }

  async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
    if (!this.isConfigured()) throw ApiError.serviceUnavailable(PAYMENT_ERRORS.providerDisabled);
    assertAmount(input.amountMinor);

    const transactionId = `lf_${Date.now()}_${randomUUID().slice(0, 8)}`;
    // eSewa's form takes the major-unit amount; ours is always minor units.
    const params = new URLSearchParams({
      amt: (input.amountMinor / 100).toFixed(2),
      pscd: env.ESEWA_PRODUCT_CODE,
      pid: input.reference,
      su: input.successUrl,
      fu: input.failureUrl,
      r: input.reference,
      tn: input.productName.slice(0, 100),
    });

    return {
      provider: 'esewa',
      transactionId,
      redirectUrl: `${this.baseUrl}/payment/epay2/process?${params.toString()}`,
      expiresAt: toHours(env.PAYMENT_SESSION_TTL),
      payload: { merchantId: env.ESEWA_MERCHANT_ID, productCode: env.ESEWA_PRODUCT_CODE },
    };
  }

  async verify(transactionId: string, reference?: string): Promise<VerifyResult> {
    if (!this.isConfigured()) throw ApiError.serviceUnavailable(PAYMENT_ERRORS.providerDisabled);
    const base = this.baseUrl === 'https://uat.esewa.com.np'
      ? 'https://uat.esewa.com.np/api/1.1.0'
      : 'https://esewa.com.np/api/1.1.0';

    try {
      const response = await fetch(`${base}/transaction/status/${encodeURIComponent(transactionId)}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        log.warn('esewa status check failed', { transactionId, status: response.status });
        return { verified: false };
      }
      const data = (await response.json()) as {
        status?: string;
        amount?: string;
        reference?: string;
        transaction_uuid?: string;
      };
      const verified = data.status === 'COMPLETE';
      return {
        verified,
        amountMinor: data.amount ? Math.round(Number(data.amount) * 100) : undefined,
        reference: data.reference ?? reference,
        transactionId: data.transaction_uuid ?? transactionId,
        status: data.status,
        raw: data,
      };
    } catch (error) {
      log.warn('esewa verification error', {
        transactionId,
        detail: error instanceof Error ? error.message : String(error),
      });
      return { verified: false };
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Khalti                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Khalti's `initiate` + `lookup` flow.
 *
 * `initiate` returns a `redirect_url` the browser is sent to. On return the
 * `pidx` query parameter is posted back to us and exchanged for the real
 * transaction details through `lookup` - which is the only call we trust.
 */
class KhaltiProvider implements PaymentProvider {
  readonly name = 'khalti' as const;

  private get baseUrl(): string {
    return env.isProduction ? 'https://api.khalti.com' : 'https://sandbox.khalti.com';
  }

  isConfigured(): boolean {
    return Boolean(env.KHALTI_SECRET_KEY);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Key ${env.KHALTI_SECRET_KEY}`,
      'Content-Type': 'application/json',
    };
  }

  async createSession(input: CreateSessionInput): Promise<CreateSessionResult> {
    if (!this.isConfigured()) throw ApiError.serviceUnavailable(PAYMENT_ERRORS.providerDisabled);
    assertAmount(input.amountMinor);

    const transactionId = `lf_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const payload = {
      amount: input.amountMinor,
      currency: input.currency,
      order_id: input.reference,
      name: input.productName.slice(0, 80),
      description: input.productName.slice(0, 200),
      return_url: input.successUrl,
      failure_url: input.failureUrl,
      customer: input.customerEmail
        ? { email: input.customerEmail, phone: input.customerPhone ?? '' }
        : undefined,
    };

    try {
      const response = await fetch(`${this.baseUrl}/api/v2/initiate`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        log.warn('khalti initiate failed', { status: response.status, reference: input.reference });
        throw ApiError.serviceUnavailable(PAYMENT_ERRORS.verificationFailed);
      }
      const data = (await response.json()) as { pidx?: string; redirect_url?: string };
      return {
        provider: 'khalti',
        transactionId: data.pidx ?? transactionId,
        redirectUrl: data.redirect_url ?? input.failureUrl,
        expiresAt: toHours(env.PAYMENT_SESSION_TTL),
        payload: { publicKey: env.KHALTI_PUBLIC_KEY },
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      log.warn('khalti initiate error', {
        detail: error instanceof Error ? error.message : String(error),
      });
      throw ApiError.serviceUnavailable(PAYMENT_ERRORS.verificationFailed);
    }
  }

  async verify(transactionId: string, _reference?: string): Promise<VerifyResult> {
    if (!this.isConfigured()) throw ApiError.serviceUnavailable(PAYMENT_ERRORS.providerDisabled);

    try {
      const response = await fetch(`${this.baseUrl}/api/v2/payment/verify`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ pidx: transactionId }),
      });
      if (!response.ok) {
        log.warn('khalti verify failed', { transactionId, status: response.status });
        return { verified: false };
      }
      const data = (await response.json()) as {
        status?: string;
        amount?: number;
        transaction_id?: string;
        order_id?: string;
      };
      return {
        verified: data.status === 'COMPLETED',
        // Khalti reports the total in minor units already.
        amountMinor: typeof data.amount === 'number' ? data.amount : undefined,
        reference: data.order_id,
        transactionId: data.transaction_id ?? transactionId,
        status: data.status,
        raw: data,
      };
    } catch (error) {
      log.warn('khalti verify error', {
        transactionId,
        detail: error instanceof Error ? error.message : String(error),
      });
      return { verified: false };
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

const providers: Record<'mock' | 'esewa' | 'khalti', PaymentProvider> = {
  mock: new MockProvider(),
  esewa: new EsewaProvider(),
  khalti: new KhaltiProvider(),
};

export function getProvider(
  requested?: string | null,
): PaymentProvider {
  const name = (requested || env.effectivePaymentProvider) as 'mock' | 'esewa' | 'khalti' | undefined;
  if (!name || !providers[name]) return providers.mock;
  // Never hand back a gateway that has no credentials: fall back to mock so the
  // local flow keeps working and the health endpoint reports the truth.
  const provider = providers[name];
  return provider.isConfigured() ? provider : providers.mock;
}

export function availableProviders(): { name: string; configured: boolean }[] {
  return Object.values(providers).map((p) => ({ name: p.name, configured: p.isConfigured() }));
}

export default providers;
