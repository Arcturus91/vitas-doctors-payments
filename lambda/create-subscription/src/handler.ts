import type { APIGatewayProxyHandler } from 'aws-lambda';
import { resolveAuthContext } from '../../shared/src/auth-context';
import {
  toHttpResponse,
  NotFoundError,
  ConflictError,
  ValidationError,
} from '../../shared/src/errors';
import { logger } from '../../shared/src/logger';
import {
  getPlan,
  getSubscription,
  createSubscription,
  ConditionalCheckFailedException,
} from '../../shared/src/ddb-repo';
import { getMercadoPagoAccessToken } from '../../shared/src/secrets';
import { providerFactory } from '../../shared/src/provider';
import type { Subscription } from '../../shared/src/types';

// Statuses that block creating a new subscription.
// PENDING is excluded: it means the user opened checkout but didn't pay yet,
// so they should be allowed to retry (the old PENDING record gets overwritten).
const BLOCKING_STATUSES: ReadonlySet<string> = new Set([
  'ACTIVE', 'TRIAL', 'PAST_DUE', 'PENDING_CANCEL',
]);

export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const { userId, doctorId } = await resolveAuthContext(event);

    // ── Parse & validate body ─────────────────────────────────────────────
    const body = JSON.parse(event.body ?? '{}') as {
      planId?: string;
      billingCycle?: string;
      backUrl?: string;
      payerEmail?: string;
    };

    if (!body.planId) {
      throw new ValidationError('planId is required');
    }
    if (!body.billingCycle || !['monthly', 'yearly'].includes(body.billingCycle)) {
      throw new ValidationError('billingCycle must be "monthly" or "yearly"');
    }

    const billingCycle = body.billingCycle as 'monthly' | 'yearly';

    logger.info('create-subscription: request', { userId, planId: body.planId, billingCycle });

    // ── Read plan ─────────────────────────────────────────────────────────
    const plan = await getPlan(body.planId);
    if (!plan) throw new NotFoundError('Plan');
    if (!plan.active) throw new ValidationError('Plan is not currently available');

    // ── Conflict guard ────────────────────────────────────────────────────
    const existing = await getSubscription(userId);
    if (existing && BLOCKING_STATUSES.has(existing.status)) {
      throw new ConflictError(
        'You already have an active subscription. Cancel it before creating a new one.',
      );
    }

    // ── Notification URL — resolved at deploy time via env var (more reliable than requestContext) ──
    const notificationUrl = process.env.WEBHOOK_NOTIFICATION_URL;

    // ── Call payment provider ─────────────────────────────────────────────
    const token    = await getMercadoPagoAccessToken();
    const provider = providerFactory('mercadopago', token);

    const { checkoutUrl, providerSubscriptionId } = await provider.createSubscription({
      userId,
      planId:    plan.planId,
      planName:  plan.name,
      billingCycle,
      amount:    plan.price,
      currency:  plan.currency,
      payerEmail:      process.env.MP_DEFAULT_PAYER_EMAIL ?? body.payerEmail,
      backUrl:         body.backUrl,
      notificationUrl,
    });

    // ── Build subscription item ───────────────────────────────────────────
    const now            = new Date().toISOString();
    const subscriptionId = crypto.randomUUID();

    // Status starts as PENDING regardless of trial — access is only granted
    // after the webhook confirms a successful payment (Checkout Pro flow).
    const subscription: Subscription = {
      PK:     `USER#${userId}`,
      SK:     'SUBSCRIPTION#primary',
      entity: 'subscription',
      subscriptionId,
      userId,
      ...(doctorId ? { doctorId } : {}),
      planId:               plan.planId,
      status:               'PENDING',
      billingCycle,
      provider:             'mercadopago',
      providerSubscriptionId,
      GSI1PK:               `PROVIDER_SUB#${providerSubscriptionId}`,
      GSI1SK:               `USER#${userId}`,
      limitsCached:         plan.limits,
      gracePeriodDays:      plan.gracePeriodDays,
      createdAt:  now,
      updatedAt:  now,
    };

    // ── Persist (idempotency: condition attribute_not_exists) ─────────────
    try {
      await createSubscription(subscription);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new ConflictError('A subscription record already exists for this user');
      }
      throw err;
    }

    logger.info('create-subscription: success', {
      userId, subscriptionId, providerSubscriptionId,
    });

    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkoutUrl, subscriptionId }),
    };
  } catch (error) {
    logger.error('create-subscription error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return toHttpResponse(error);
  }
};
