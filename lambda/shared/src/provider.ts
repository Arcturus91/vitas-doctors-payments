// ─── Input / Output Types ─────────────────────────────────────────────────────

export interface CreateSubscriptionInput {
  userId: string;
  planId: string;
  /** Human-readable plan name — used as the subscription "reason" shown to payers */
  planName: string;
  billingCycle: 'monthly' | 'yearly';
  /** Transaction amount (plan price) */
  amount: number;
  /** ISO 4217 currency code, e.g. 'ARS', 'BRL', 'MXN' */
  currency: string;
  /** Number of free trial days before first charge. 0 or omit for no trial. */
  trialDays?: number;
  payerEmail?: string;
  /** URL to redirect user after checkout is completed */
  backUrl?: string;
  /** Webhook URL the provider will call for payment events */
  notificationUrl?: string;
}

export interface CreateSubscriptionResult {
  /** URL to redirect the user to complete checkout */
  checkoutUrl: string;
  /** Provider-specific subscription/preapproval ID */
  providerSubscriptionId: string;
}

export interface NormalizedPayment {
  providerPaymentId: string;
  providerSubscriptionId?: string;
  status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'REFUNDED';
  amount: number;
  currency: string;
  rawPayload: Record<string, unknown>; // full provider response, stored for audit
}

export interface NormalizedSubscription {
  providerSubscriptionId: string;
  status: 'PENDING' | 'ACTIVE' | 'CANCELED' | 'PAST_DUE' | 'PAUSED';
  rawPayload: Record<string, unknown>;
}

// ─── Provider Interface ───────────────────────────────────────────────────────

/**
 * Payment provider abstraction.
 *
 * All payment providers must implement this interface.
 * This allows swapping MercadoPago → Stripe → PayPal without touching Lambda handlers.
 *
 * Current implementations: MercadoPagoAdapter (Stage 7)
 * Future: StripeAdapter, PayPalAdapter
 */
export interface IPaymentProvider {
  createSubscription(input: CreateSubscriptionInput): Promise<CreateSubscriptionResult>;
  cancelSubscription(providerSubscriptionId: string): Promise<void>;

  /**
   * Fetch authoritative payment data from the provider API.
   * MUST always be called from webhook-processor — never trust raw webhook body.
   */
  getPayment(providerPaymentId: string): Promise<NormalizedPayment>;

  /**
   * Fetch authoritative subscription/preapproval data from the provider API.
   * MUST always be called from webhook-processor — never trust raw webhook body.
   */
  getPreapproval(providerSubscriptionId: string): Promise<NormalizedSubscription>;

  /**
   * Validate webhook signature (if the provider supports it).
   * Returns true if the signature is valid, false otherwise.
   * If the provider does not support signatures, return true and rely on
   * authoritative API lookup in webhook-processor for verification.
   */
  validateWebhookSignature(payload: string, signature: string, secret: string): boolean;
}

// ─── Provider Factory ─────────────────────────────────────────────────────────

/**
 * Resolves the correct provider adapter by name.
 * The access token is injected at call time (resolved from Secrets Manager upstream).
 *
 * To add a new provider:
 *   1. Implement IPaymentProvider in a new adapter file
 *   2. Add a case here
 *   3. Add the provider's secret to Secrets Manager
 */
export function providerFactory(providerName: string, accessToken: string): IPaymentProvider {
  switch (providerName) {
    case 'mercadopago': {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { MercadoPagoAdapter } = require('./mercadopago-adapter') as typeof import('./mercadopago-adapter');
      return new MercadoPagoAdapter(accessToken);
    }
    default:
      throw new Error(`Unknown payment provider: "${providerName}". Add it to providerFactory.`);
  }
}
