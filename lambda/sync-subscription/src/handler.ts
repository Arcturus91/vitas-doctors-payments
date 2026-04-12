import type { APIGatewayProxyHandler } from 'aws-lambda';
import { resolveAuthContext } from '../../shared/src/auth-context';
import { toHttpResponse, NotFoundError } from '../../shared/src/errors';
import { logger } from '../../shared/src/logger';
import {
  getSubscription,
  updateSubscriptionStatus,
  ConditionalCheckFailedException,
} from '../../shared/src/ddb-repo';
import { getMercadoPagoAccessToken } from '../../shared/src/secrets';
import { providerFactory } from '../../shared/src/provider';
import type { Subscription } from '../../shared/src/types';

/**
 * POST /subscriptions/me/sync
 *
 * Called when the doctor returns from MercadoPago checkout with ?status=success.
 * Fetches the authoritative preapproval status from MP and activates the subscription
 * immediately — without waiting for a webhook.
 *
 * Only acts on PENDING subscriptions. Any other status is already managed by webhooks.
 * The DynamoDB Stream fires on update → EventBridge → bridge → ai_features enabled.
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const { userId } = await resolveAuthContext(event);

    const sub = await getSubscription(userId);
    if (!sub) throw new NotFoundError('Subscription');

    // Only sync when PENDING — all other transitions are owned by webhooks
    if (sub.status !== 'PENDING') {
      logger.info('sync-subscription: already past PENDING, nothing to do', {
        userId, status: sub.status,
      });
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ synced: false, status: sub.status }),
      };
    }

    logger.info('sync-subscription: fetching authoritative status from MP', {
      userId,
      providerSubscriptionId: sub.providerSubscriptionId,
    });

    const token    = await getMercadoPagoAccessToken();
    const provider = providerFactory('mercadopago', token);
    const normalized = await provider.getPreapproval(sub.providerSubscriptionId);

    // MP still processing — nothing to do yet
    if (normalized.status === 'PENDING') {
      logger.info('sync-subscription: MP still pending', { userId });
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ synced: false, status: sub.status }),
      };
    }

    // Map NormalizedSubscription status → our domain status
    const statusMap: Partial<Record<typeof normalized.status, Subscription['status']>> = {
      ACTIVE:   'ACTIVE',
      CANCELED: 'CANCELED',
      PAST_DUE: 'PAST_DUE',
      PAUSED:   'PAST_DUE',
    };
    const newStatus = statusMap[normalized.status];

    if (!newStatus) {
      logger.warn('sync-subscription: unmapped MP status — ignoring', {
        userId, mpStatus: normalized.status,
      });
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ synced: false, status: sub.status }),
      };
    }

    const now = new Date().toISOString();
    const extraAttrs: Partial<Subscription> = {};

    if (newStatus === 'CANCELED') {
      extraAttrs.canceledAt = now;
    } else if (newStatus === 'PAST_DUE') {
      const graceMs = (sub.gracePeriodDays ?? 7) * 24 * 60 * 60 * 1000;
      extraAttrs.graceEndsAt = new Date(Date.now() + graceMs).toISOString();
    }

    try {
      await updateSubscriptionStatus(userId, newStatus, 'PENDING', extraAttrs);
      logger.info('sync-subscription: activated', { userId, newStatus });
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        // Webhook beat us to it — that's fine, both results are consistent
        logger.info('sync-subscription: concurrent update already applied', { userId });
      } else {
        throw err;
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ synced: true, status: newStatus }),
    };
  } catch (error) {
    logger.error('sync-subscription error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return toHttpResponse(error);
  }
};
