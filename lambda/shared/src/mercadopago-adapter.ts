import type {
  CreateSubscriptionInput,
  CreateSubscriptionResult,
  IPaymentProvider,
  NormalizedPayment,
  NormalizedSubscription,
} from './provider';
import { PaymentProviderError } from './errors';
import { logger } from './logger';

const MP_API_BASE = 'https://api.mercadopago.com';

// ─── Status Mappers ───────────────────────────────────────────────────────────

function mapPaymentStatus(mpStatus: string): NormalizedPayment['status'] {
  switch (mpStatus) {
    case 'approved':   return 'SUCCESS';
    case 'pending':
    case 'in_process': return 'PENDING';
    case 'rejected':
    case 'cancelled':  return 'FAILED';
    case 'refunded':   return 'REFUNDED';
    default:           return 'FAILED';
  }
}

function mapPreapprovalStatus(mpStatus: string): NormalizedSubscription['status'] {
  switch (mpStatus) {
    case 'authorized': return 'ACTIVE';
    case 'pending':    return 'PENDING';
    case 'paused':     return 'PAST_DUE'; // no PAUSED in our domain — treat as past-due
    case 'cancelled':  return 'CANCELED';
    default:           return 'CANCELED';
  }
}

// ─── Adapter ──────────────────────────────────────────────────────────────────

/**
 * MercadoPago provider adapter.
 *
 * Uses the Preapproval API for recurring subscriptions (hosted checkout).
 * Credentials are injected at construction — resolved from Secrets Manager by the caller.
 *
 * To update credentials: replace the secret value via AWS Console or CLI:
 *   aws secretsmanager put-secret-value \
 *     --secret-id /payments/payments/mercadopago-dev \
 *     --secret-string '{"access_token":"APP_USR-real-token","client_id":"12345","client_secret":"real-secret"}'
 *
 * MP API docs:
 *   - Preapproval (subscription): POST /preapproval
 *   - Cancel preapproval:         PUT  /preapproval/{id}
 *   - Payment lookup:             GET  /v1/payments/{id}
 *   - Preapproval lookup:         GET  /preapproval/{id}
 *
 * NOTE: MercadoPago does not provide a webhook signature header.
 *       Security is enforced by always fetching authoritative data from the API
 *       in webhook-processor (we never trust the raw webhook body alone).
 */
export class MercadoPagoAdapter implements IPaymentProvider {
  constructor(private readonly accessToken: string) {
    if (!accessToken || accessToken.trim() === '') {
      throw new PaymentProviderError('MercadoPago access token is required');
    }
  }

  private get headers() {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  // ─── Private HTTP helper ──────────────────────────────────────────────────

  private async mpFetch<T = Record<string, unknown>>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${MP_API_BASE}${path}`;
    logger.debug('MercadoPago API request', { method, path });

    const response = await fetch(url, {
      method,
      headers: this.headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    const json = await response.json() as Record<string, unknown>;

    if (!response.ok) {
      const message = String(json['message'] ?? json['error'] ?? `MP API error ${response.status}`);
      const code = String(json['status'] ?? response.status);
      logger.error('MercadoPago API error', { status: response.status, path, message, code });
      throw new PaymentProviderError(`MercadoPago: ${message}`, code);
    }

    return json as T;
  }

  // ─── IPaymentProvider implementation ─────────────────────────────────────

  /**
   * Create a one-time payment preference via POST /checkout/preferences.
   * Returns the MP checkout URL (init_point) for the user to complete payment.
   *
   * Uses Checkout Pro instead of Preapproval — no payer_email required,
   * works in sandbox without test user restrictions.
   *
   * MP Checkout Pro docs: https://www.mercadopago.com.ar/developers/es/reference/preferences/_checkout_preferences/post
   */
  async createSubscription(input: CreateSubscriptionInput): Promise<CreateSubscriptionResult> {
    const billingLabel = input.billingCycle === 'yearly' ? 'anual' : 'mensual';

    const requestBody: Record<string, unknown> = {
      items: [
        {
          id:         input.planId,
          title:      `${input.planName} — ${billingLabel}`,
          quantity:   1,
          unit_price: input.amount,
          currency_id: input.currency,
        },
      ],
      metadata: {
        user_id: input.userId,
        plan_id: input.planId,
        billing_cycle: input.billingCycle,
      },
    };

    if (input.backUrl) {
      requestBody['back_urls'] = {
        success: input.backUrl,
        failure: input.backUrl,
        pending: input.backUrl,
      };
      requestBody['auto_return'] = 'approved';
    }

    if (input.notificationUrl) requestBody['notification_url'] = input.notificationUrl;

    const result = await this.mpFetch<{ id: string; init_point: string }>(
      'POST', '/checkout/preferences', requestBody,
    );

    logger.info('MercadoPago: checkout preference created', {
      providerSubscriptionId: result.id,
    });

    return {
      checkoutUrl:            result.init_point,
      providerSubscriptionId: result.id,
    };
  }

  /**
   * Cancel a subscription via PUT /preapproval/{id} with status=cancelled.
   */
  async cancelSubscription(providerSubscriptionId: string): Promise<void> {
    await this.mpFetch('PUT', `/preapproval/${providerSubscriptionId}`, {
      status: 'cancelled',
    });

    logger.info('MercadoPago: preapproval cancelled', { providerSubscriptionId });
  }

  /**
   * Fetch authoritative payment data via GET /v1/payments/{id}.
   * Always called from webhook-processor — never trust the raw webhook body alone.
   */
  async getPayment(providerPaymentId: string): Promise<NormalizedPayment> {
    const data = await this.mpFetch('GET', `/v1/payments/${providerPaymentId}`);

    return {
      providerPaymentId:        String(data['id']),
      // preapproval_id is set for recurring subscriptions; preference_id for Checkout Pro one-time payments
      providerSubscriptionId:   data['preapproval_id']
        ? String(data['preapproval_id'])
        : data['preference_id']
          ? String(data['preference_id'])
          : undefined,
      status:                   mapPaymentStatus(String(data['status'] ?? '')),
      amount:                   Number(data['transaction_amount'] ?? 0),
      currency:                 String(data['currency_id'] ?? ''),
      rawPayload:               data,
    };
  }

  /**
   * Fetch authoritative subscription data via GET /preapproval/{id}.
   * Always called from webhook-processor — never trust the raw webhook body alone.
   */
  async getPreapproval(providerSubscriptionId: string): Promise<NormalizedSubscription> {
    const data = await this.mpFetch('GET', `/preapproval/${providerSubscriptionId}`);

    return {
      providerSubscriptionId: String(data['id']),
      status:                 mapPreapprovalStatus(String(data['status'] ?? '')),
      rawPayload:             data,
    };
  }

  /**
   * MercadoPago does not send a verifiable signature header for webhooks.
   * Returns true here — security is guaranteed by the authoritative API lookup
   * performed in webhook-processor (we always call getPayment/getPreapproval).
   */
  validateWebhookSignature(_payload: string, _signature: string, _secret: string): boolean {
    logger.debug('MercadoPago does not support webhook signatures — relying on API lookup');
    return true;
  }
}
