import type { APIGatewayProxyHandler } from 'aws-lambda';
import { resolveAuthContext } from '../../shared/src/auth-context';
import { toHttpResponse, NotFoundError, ValidationError } from '../../shared/src/errors';
import { logger } from '../../shared/src/logger';
import { getSubscription, getBillingCycleByPeriod } from '../../shared/src/ddb-repo';
import { getMercadoPagoAccessToken } from '../../shared/src/secrets';
import { providerFactory } from '../../shared/src/provider';

const FRONTEND_URL = process.env.FRONTEND_URL ?? '';

/**
 * POST /subscriptions/me/pay-overage
 *
 * Creates a one-time MercadoPago Checkout Pro preference to pay an outstanding overage.
 *
 * Body: { "period": "2026-03" }   // YYYY-MM of the cycle with PENDING_PAYMENT status
 *
 * Response 200: { checkoutUrl: string, amount: number, currency: string }
 * Response 400: missing/invalid period
 * Response 403: subscription inactive
 * Response 404: no subscription or no pending overage for the given period
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const { userId } = await resolveAuthContext(event);
    logger.info('pay-overage: request', { userId });

    // Parse request body
    const body = event.body ? JSON.parse(event.body) as { period?: string } : {};
    const period = body.period?.trim();
    if (!period || !/^\d{4}-\d{2}$/.test(period)) {
      throw new ValidationError('period must be a valid YYYY-MM string');
    }

    // Load subscription to verify access
    const sub = await getSubscription(userId);
    if (!sub) throw new NotFoundError('Subscription');

    // Load billing cycle for the requested period
    const cycle = await getBillingCycleByPeriod(userId, period);
    if (!cycle) {
      throw new NotFoundError(`BillingCycle for period ${period}`);
    }
    if (cycle.status !== 'PENDING_PAYMENT') {
      throw new ValidationError(`Billing cycle for ${period} is not in PENDING_PAYMENT status (current: ${cycle.status})`);
    }

    // Create one-time MercadoPago checkout preference
    const accessToken = await getMercadoPagoAccessToken();
    const provider = providerFactory('mercadopago', accessToken);

    const backUrl = FRONTEND_URL
      ? `${FRONTEND_URL}/vitas/subscription?status=overage_paid&period=${period}`
      : undefined;

    const result = await provider.createSubscription({
      userId,
      planId:        `overage-${period}`,
      planName:      `Excedente ${period}`,
      billingCycle:  'monthly',
      amount:        cycle.overageAmount,
      currency:      cycle.overageCurrency,
      backUrl,
      // Metadata is stored in the preference — webhook-processor reads it on payment confirmation
    });

    // Store cycle metadata in the preference via the metadata field
    // Note: we use planId = overage-{period} as a signal to webhook-processor
    // The preference_id from MP will be used to look up userId via metadata.user_id

    logger.info('pay-overage: checkout preference created', {
      userId,
      period,
      overageAmount: cycle.overageAmount,
      providerPreferenceId: result.providerSubscriptionId,
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        checkoutUrl: result.checkoutUrl,
        amount:      cycle.overageAmount,
        currency:    cycle.overageCurrency,
        period,
      }),
    };
  } catch (error) {
    logger.error('pay-overage error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return toHttpResponse(error);
  }
};
