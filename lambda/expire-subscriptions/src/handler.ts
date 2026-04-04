import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  ddb,
  getCoreTableName,
  scanSubscriptionsByStatus,
} from '../../shared/src/ddb-repo';
import { logger } from '../../shared/src/logger';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Subscription } from '../../shared/src/types';

// ─── Expire Subscriptions Lambda ──────────────────────────────────────────────
//
// Triggered hourly by EventBridge.
// Scans SaasCore for subscriptions that have passed their expiry dates and
// transitions them to DOWNGRADED_TO_MANUAL.
//
// Transitions performed:
//   TRIAL     + trialEndsAt  < now → DOWNGRADED_TO_MANUAL
//   PAST_DUE  + graceEndsAt  < now → DOWNGRADED_TO_MANUAL
//   PENDING   + createdAt    < now - 48h → CANCELED (abandoned checkout)
//
// Each update is idempotent via a condition expression on the expected status.
// DynamoDB Stream → EventBridge will fire subscription.status.changed,
// which triggers the bridge Lambda to disable ai_features in Doctors_Table_V2.

export const handler = async (): Promise<void> => {
  const now = new Date().toISOString();
  const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  logger.info({ now }, 'expire-subscriptions: starting scan');

  // 1. Scan for TRIAL + PAST_DUE + PENDING subscriptions
  const candidates = await scanSubscriptionsByStatus(['TRIAL', 'PAST_DUE', 'PENDING']);
  logger.info({ count: candidates.length }, 'expire-subscriptions: candidates found');

  let expired = 0;
  let abandoned = 0;
  let skipped = 0;

  for (const sub of candidates) {
    const result = await tryExpire(sub, now, cutoff48h);
    if (result === 'expired') expired++;
    else if (result === 'abandoned') abandoned++;
    else skipped++;
  }

  logger.info({ expired, abandoned, skipped }, 'expire-subscriptions: done');
};

async function tryExpire(
  sub: Subscription,
  now: string,
  cutoff48h: string,
): Promise<'expired' | 'abandoned' | 'skipped'> {
  const tableName = getCoreTableName();

  if (sub.status === 'TRIAL') {
    if (!sub.trialEndsAt || sub.trialEndsAt > now) return 'skipped';
    return transitionStatus(tableName, sub, 'TRIAL', 'DOWNGRADED_TO_MANUAL', 'expired');
  }

  if (sub.status === 'PAST_DUE') {
    if (!sub.graceEndsAt || sub.graceEndsAt > now) return 'skipped';
    return transitionStatus(tableName, sub, 'PAST_DUE', 'DOWNGRADED_TO_MANUAL', 'expired');
  }

  if (sub.status === 'PENDING') {
    if (sub.createdAt > cutoff48h) return 'skipped';
    return transitionStatus(tableName, sub, 'PENDING', 'CANCELED', 'abandoned');
  }

  return 'skipped';
}

async function transitionStatus(
  tableName: string,
  sub: Subscription,
  expectedStatus: string,
  newStatus: string,
  resultLabel: 'expired' | 'abandoned',
): Promise<'expired' | 'abandoned' | 'skipped'> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { PK: sub.PK, SK: sub.SK },
      UpdateExpression: 'SET #status = :newStatus, updatedAt = :now',
      ConditionExpression: 'attribute_exists(PK) AND #status = :expectedStatus',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':newStatus': newStatus,
        ':expectedStatus': expectedStatus,
        ':now': new Date().toISOString(),
      },
    }));

    logger.info(
      { userId: sub.userId, subscriptionId: sub.subscriptionId, oldStatus: expectedStatus, newStatus },
      'expire-subscriptions: transitioned',
    );
    return resultLabel;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      // Already transitioned by a concurrent execution — safe to ignore
      logger.debug({ subscriptionId: sub.subscriptionId }, 'expire-subscriptions: condition check failed (already transitioned)');
      return 'skipped';
    }
    logger.error({ subscriptionId: sub.subscriptionId, err }, 'expire-subscriptions: update failed');
    throw err;
  }
}
