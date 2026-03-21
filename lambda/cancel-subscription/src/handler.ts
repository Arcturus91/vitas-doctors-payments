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
  getSubscription,
  updateSubscriptionStatus,
  writeEvent,
  ConditionalCheckFailedException,
} from '../../shared/src/ddb-repo';
import { getMercadoPagoAccessToken } from '../../shared/src/secrets';
import { providerFactory } from '../../shared/src/provider';

/**
 * POST /subscriptions/{id}/cancel
 *
 * Cancels the authenticated user's subscription.
 * Sets status to PENDING_CANCEL — provider handles access-until-period-end.
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const { userId } = await resolveAuthContext(event);
    const subscriptionId = event.pathParameters?.id;

    if (!subscriptionId) throw new ValidationError('Missing subscriptionId in path');

    logger.info('cancel-subscription: request', { userId, subscriptionId });

    // ── Read and authorize ────────────────────────────────────────────────
    const sub = await getSubscription(userId);
    if (!sub) throw new NotFoundError('Subscription');

    // IDOR guard: the subscriptionId in the URL must belong to this user
    if (sub.subscriptionId !== subscriptionId) throw new NotFoundError('Subscription');

    if (sub.status === 'CANCELED') {
      throw new ConflictError('Subscription is already canceled');
    }
    if (sub.status === 'PENDING_CANCEL') {
      throw new ConflictError('Subscription cancellation is already pending');
    }

    // ── Cancel at provider (best-effort) ─────────────────────────────────
    // For Preapproval subscriptions: cancels the recurring billing at MP.
    // For Checkout Pro preferences (one-time payments): no MP-side cancel needed —
    // the preference ID is not cancellable via this endpoint, so we log and continue.
    try {
      const token    = await getMercadoPagoAccessToken();
      const provider = providerFactory('mercadopago', token);
      await provider.cancelSubscription(sub.providerSubscriptionId);
    } catch (err) {
      logger.warn('cancel-subscription: provider cancel failed (may be a one-time payment preference) — continuing with local status update', {
        providerSubscriptionId: sub.providerSubscriptionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // ── Update local status ───────────────────────────────────────────────
    const now = new Date().toISOString();

    try {
      await updateSubscriptionStatus(userId, 'PENDING_CANCEL', sub.status, {
        canceledAt: now,
      });
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        // Status changed between read and update — still safe, provider already cancelled.
        // Proceed to write the event so we have an audit record.
        logger.warn('cancel-subscription: status changed concurrently — audit event still written', {
          userId, subscriptionId,
        });
      } else {
        throw err;
      }
    }

    // ── Audit event ───────────────────────────────────────────────────────
    await writeEvent({
      PK:     `SUBSCRIPTION#${subscriptionId}`,
      SK:     `EVENT#${now}#${crypto.randomUUID()}`,
      entity: 'event',
      type:   'SUBSCRIPTION_CANCEL_REQUESTED',
      payload: { userId, subscriptionId, previousStatus: sub.status },
      createdAt: now,
    });

    logger.info('cancel-subscription: success', { userId, subscriptionId });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriptionId, status: 'PENDING_CANCEL' }),
    };
  } catch (error) {
    logger.error('cancel-subscription error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return toHttpResponse(error);
  }
};
