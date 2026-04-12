import type { ScheduledHandler } from 'aws-lambda';
import {
  scanSubscriptionsByStatus,
  updateSubscriptionStatus,
  ConditionalCheckFailedException,
} from '../../shared/src/ddb-repo';
import { getMercadoPagoAccessToken } from '../../shared/src/secrets';
import { providerFactory } from '../../shared/src/provider';
import { logger } from '../../shared/src/logger';
import type { Subscription } from '../../shared/src/types';

/**
 * EventBridge scheduled Lambda — runs every 5 minutes.
 *
 * Scans for PENDING subscriptions and syncs their status from the payment
 * provider. This is the server-side activation path: completely independent
 * of whether the user returns to the browser after paying.
 *
 * Flow:
 *   1. Scan DynamoDB for all PENDING subscriptions
 *   2. Skip any created in the last 2 minutes (let the inline sync-subscription
 *      route handle fresh checkouts first — avoids unnecessary MP API calls)
 *   3. For each remaining PENDING: GET /preapproval/{id} from MP
 *      - authorized → ACTIVE  (DynamoDB Stream fires → EventBridge → bridge → ai_features)
 *      - cancelled  → CANCELED
 *      - pending    → skip (will retry on next 5-min tick)
 *   4. Abandon subscriptions stuck in PENDING for > 48h → CANCELED
 *
 * Idempotent: updateSubscriptionStatus uses a conditional update (expectedStatus=PENDING).
 * If the webhook or inline sync already updated the record, the condition fails silently.
 */
export const handler: ScheduledHandler = async () => {
  logger.info('sync-pending-subscriptions: invoked');

  const pendingSubs = await scanSubscriptionsByStatus(['PENDING']);

  if (pendingSubs.length === 0) {
    logger.info('sync-pending-subscriptions: no PENDING subscriptions found');
    return;
  }

  logger.info('sync-pending-subscriptions: found PENDING subscriptions', {
    count: pendingSubs.length,
  });

  const now = Date.now();
  const TWO_MINUTES_MS = 2 * 60 * 1000;
  const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;

  // Fetch MP token once — shared across all subscriptions in this batch.
  // Skip if no subscriptions need MP lookup (all are too fresh or all are trial IDs).
  const subsNeedingLookup = pendingSubs.filter((sub) => {
    const ageMs = now - new Date(sub.createdAt).getTime();
    const isFresh = ageMs < TWO_MINUTES_MS;
    const isStale = ageMs > FORTY_EIGHT_HOURS_MS;
    // Trial subscriptions use a "trial-*" provider ID — no MP preapproval to look up
    const isTrial = sub.providerSubscriptionId?.startsWith('trial-');
    return !isFresh && !isStale && !isTrial;
  });

  // Abandon stale PENDING subscriptions (48h+ with no payment — checkout abandoned)
  const staleIds = pendingSubs
    .filter((sub) => now - new Date(sub.createdAt).getTime() > FORTY_EIGHT_HOURS_MS)
    .map((sub) => sub.userId);

  for (const userId of staleIds) {
    try {
      await updateSubscriptionStatus(userId, 'CANCELED', 'PENDING', {
        canceledAt: new Date().toISOString(),
      });
      logger.info('sync-pending-subscriptions: abandoned checkout → CANCELED', { userId });
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        // Already updated by webhook/inline sync — no-op
      } else {
        logger.error('sync-pending-subscriptions: error abandoning stale subscription', {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (subsNeedingLookup.length === 0) {
    logger.info('sync-pending-subscriptions: no subscriptions need MP lookup this tick');
    return;
  }

  let token: string;
  try {
    token = await getMercadoPagoAccessToken();
  } catch (err) {
    logger.error('sync-pending-subscriptions: failed to get MP access token', {
      error: err instanceof Error ? err.message : String(err),
    });
    // Non-fatal — will retry on next tick
    return;
  }

  const provider = providerFactory('mercadopago', token);

  let activated = 0;
  let canceled = 0;
  let stillPending = 0;
  let errors = 0;

  for (const sub of subsNeedingLookup) {
    try {
      const normalized = await provider.getPreapproval(sub.providerSubscriptionId);

      if (normalized.status === 'PENDING') {
        stillPending++;
        continue;
      }

      const statusMap: Partial<Record<typeof normalized.status, Subscription['status']>> = {
        ACTIVE:   'ACTIVE',
        CANCELED: 'CANCELED',
        PAST_DUE: 'PAST_DUE',
        PAUSED:   'PAST_DUE',
      };
      const newStatus = statusMap[normalized.status];

      if (!newStatus) {
        logger.warn('sync-pending-subscriptions: unmapped MP status', {
          userId: sub.userId,
          mpStatus: normalized.status,
        });
        continue;
      }

      const extraAttrs: Partial<Subscription> = {};
      if (newStatus === 'CANCELED') {
        extraAttrs.canceledAt = new Date().toISOString();
      } else if (newStatus === 'PAST_DUE') {
        const graceMs = (sub.gracePeriodDays ?? 7) * 24 * 60 * 60 * 1000;
        extraAttrs.graceEndsAt = new Date(Date.now() + graceMs).toISOString();
      }

      try {
        await updateSubscriptionStatus(sub.userId, newStatus, 'PENDING', extraAttrs);
        logger.info('sync-pending-subscriptions: status updated', {
          userId: sub.userId,
          newStatus,
        });
        if (newStatus === 'ACTIVE') activated++;
        else canceled++;
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) {
          // Webhook or inline sync beat us — already consistent
          logger.info('sync-pending-subscriptions: concurrent update already applied', {
            userId: sub.userId,
          });
        } else {
          throw err;
        }
      }
    } catch (err) {
      errors++;
      logger.error('sync-pending-subscriptions: error processing subscription', {
        userId: sub.userId,
        providerSubscriptionId: sub.providerSubscriptionId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Continue with next subscription — don't let one failure block others
    }
  }

  logger.info('sync-pending-subscriptions: done', {
    activated,
    canceled,
    stillPending,
    errors,
    abandoned: staleIds.length,
  });
};
