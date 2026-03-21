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

// Statuses that indicate a user already has a live subscription
const BLOCKING_STATUSES: ReadonlySet<string> = new Set([
  'ACTIVE', 'TRIAL', 'PENDING', 'PAST_DUE', 'PENDING_CANCEL',
]);

export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const { userId } = await resolveAuthContext(event);

    // ── Parse & validate body ─────────────────────────────────────────────
    const body = JSON.parse(event.body ?? '{}') as {
      planId?: string;
      billingCycle?: string;
      backUrl?: string;
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

    // ── Build notification URL from the gateway domain ────────────────────
    const domain = event.requestContext.domainName;
    const stage  = event.requestContext.stage;
    const notificationUrl = domain
      ? `https://${domain}/${stage}/webhooks/mercadopago`
      : undefined;

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
      trialDays: plan.trialDays > 0 ? plan.trialDays : undefined,
      backUrl:         body.backUrl,
      notificationUrl,
    });

    // ── Build subscription item ───────────────────────────────────────────
    const now            = new Date().toISOString();
    const subscriptionId = crypto.randomUUID();
    const isTrialPlan    = (plan.trialDays ?? 0) > 0;

    const subscription: Subscription = {
      PK:     `USER#${userId}`,
      SK:     'SUBSCRIPTION#primary',
      entity: 'subscription',
      subscriptionId,
      userId,
      planId:               plan.planId,
      status:               isTrialPlan ? 'TRIAL' : 'PENDING',
      billingCycle,
      provider:             'mercadopago',
      providerSubscriptionId,
      GSI1PK:               `PROVIDER_SUB#${providerSubscriptionId}`,
      GSI1SK:               `USER#${userId}`,
      limitsCached:         plan.limits,
      gracePeriodDays:      plan.gracePeriodDays,
      ...(isTrialPlan && {
        trialEndsAt: new Date(
          Date.now() + plan.trialDays * 24 * 60 * 60 * 1000,
        ).toISOString(),
      }),
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
