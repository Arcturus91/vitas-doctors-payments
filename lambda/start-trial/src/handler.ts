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
  createTrialSubscription,
  ConditionalCheckFailedException,
} from '../../shared/src/ddb-repo';
import type { Subscription } from '../../shared/src/types';

// Statuses that block starting a trial.
// DOWNGRADED_TO_MANUAL is included: trial was already used — must subscribe to paid plan.
// CANCELED is NOT included: a canceled paid subscription does not block a trial.
// PENDING is NOT included: abandoned checkout can be overwritten.
const BLOCKING_STATUSES: ReadonlySet<string> = new Set([
  'ACTIVE',
  'TRIAL',
  'PAST_DUE',
  'PENDING_CANCEL',
  'DOWNGRADED_TO_MANUAL',
]);

export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const { userId, doctorId } = await resolveAuthContext(event);

    const body = JSON.parse(event.body ?? '{}') as { planId?: string };
    if (!body.planId) throw new ValidationError('planId is required');

    logger.info('start-trial: request', { userId, planId: body.planId });

    // ── Validate plan ───────────────────────────────────────────────────────
    const plan = await getPlan(body.planId);
    if (!plan) throw new NotFoundError('Plan');
    if (!plan.active) throw new ValidationError('Plan is not currently available');
    if (!plan.trialDays || plan.trialDays <= 0) {
      throw new ValidationError('This plan does not have a free trial period');
    }

    // ── Conflict guard ──────────────────────────────────────────────────────
    const existing = await getSubscription(userId);
    if (existing && BLOCKING_STATUSES.has(existing.status)) {
      const message = existing.status === 'DOWNGRADED_TO_MANUAL'
        ? 'Your free trial has already been used. Please subscribe to a paid plan.'
        : 'You already have an active subscription. Cancel it before starting a trial.';
      throw new ConflictError(message);
    }

    // ── Build trial subscription ─────────────────────────────────────────────
    const now          = new Date();
    const trialEndsAt  = new Date(now.getTime() + plan.trialDays * 24 * 60 * 60 * 1000).toISOString();
    const subscriptionId = crypto.randomUUID();
    const nowIso       = now.toISOString();

    const subscription: Subscription = {
      PK:     `USER#${userId}`,
      SK:     'SUBSCRIPTION#primary',
      entity: 'subscription',
      subscriptionId,
      userId,
      ...(doctorId ? { doctorId } : {}),
      planId:                'plan-vitas-pro-monthly',
      status:                'TRIAL',
      billingCycle:          'monthly',
      provider:              'none',
      // Dummy providerSubscriptionId so GSI1 is populated consistently
      providerSubscriptionId: `trial-${subscriptionId}`,
      GSI1PK: `PROVIDER_SUB#trial-${subscriptionId}`,
      GSI1SK: `USER#${userId}`,
      limitsCached:    plan.limits,
      gracePeriodDays: plan.gracePeriodDays,
      trialEndsAt,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    // ── Persist ─────────────────────────────────────────────────────────────
    try {
      await createTrialSubscription(subscription);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new ConflictError('A subscription record already exists for this user');
      }
      throw err;
    }

    logger.info('start-trial: success', { userId, subscriptionId, trialEndsAt });

    // The DynamoDB Stream on SaasCore will trigger subscription-events-processor
    // which emits an EventBridge event → vitas-main-stack bridge enables ai_features.

    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriptionId, trialEndsAt }),
    };
  } catch (error) {
    logger.error('start-trial error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return toHttpResponse(error);
  }
};
