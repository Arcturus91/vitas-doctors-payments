import { v4 as uuidv4 } from 'uuid';
import {
  scanSubscriptionsByStatus,
  getAllUsageForSubscription,
  getBillingCycleByPeriod,
  createBillingCycle,
  updateSubscriptionStatus,
  ConditionalCheckFailedException,
} from '../../shared/src/ddb-repo';
import { logger } from '../../shared/src/logger';
import type { BillingCycleRecord } from '../../shared/src/types';

// ─── Monthly Close Lambda ──────────────────────────────────────────────────────
//
// Triggered on the 1st of each month at 05:10 UTC (00:10 UTC-5).
// EventBridge cron: cron(10 5 1 * ? *)
//
// For each ACTIVE / TRIAL subscription:
//   1. Snapshot all usage counters into a BillingCycle record
//   2. Calculate overage units and amount using plan overage_prices
//   3. If overage > 0: status = PENDING_PAYMENT, track consecutiveUnpaidCount
//   4. If overage = 0: status = CLOSED
//
// Idempotent: createBillingCycle uses attribute_not_exists condition.

const OVERAGE_PRICES: Record<string, number> = {
  scribe_minutes:         0.90,
  chatbot_messages:       0.10,
  whatsapp_conversations: 0.90,
};

const OVERAGE_CURRENCY = 'PEN';

export const handler = async (): Promise<void> => {
  const now = new Date();
  // Previous month
  const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const period = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`;
  const startDate = prevMonth.toISOString().substring(0, 10);
  const endDate = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().substring(0, 10); // last day of prev month

  logger.info({ period }, 'monthly-close: starting');

  const subscriptions = await scanSubscriptionsByStatus(['ACTIVE', 'TRIAL', 'PENDING_CANCEL']);
  logger.info({ count: subscriptions.length, period }, 'monthly-close: subscriptions to process');

  let closed = 0;
  let pendingPayment = 0;
  let skipped = 0;
  let errors = 0;

  for (const sub of subscriptions) {
    try {
      // Snapshot usage for the period
      const usageMap = await getAllUsageForSubscription(sub.userId, sub.subscriptionId);

      // Calculate overage per feature
      const limits = sub.limitsCached ?? {};
      const overageUnits: Record<string, number> = {};
      let overageAmount = 0;

      for (const [feature, limit] of Object.entries(limits)) {
        if (limit === -1) continue; // unlimited
        const used = usageMap[feature] ?? 0;
        const excess = Math.max(0, used - limit);
        if (excess > 0) {
          overageUnits[feature] = excess;
          const unitPrice = OVERAGE_PRICES[feature] ?? 0;
          overageAmount += excess * unitPrice;
        }
      }

      // Round to 2 decimal places
      overageAmount = Math.round(overageAmount * 100) / 100;

      // Check consecutive unpaid count from previous cycle
      const prevPeriodDate = new Date(prevMonth.getFullYear(), prevMonth.getMonth() - 1, 1);
      const prevPeriod = `${prevPeriodDate.getFullYear()}-${String(prevPeriodDate.getMonth() + 1).padStart(2, '0')}`;
      const prevCycle = await getBillingCycleByPeriod(sub.userId, prevPeriod);
      const prevUnpaidCount = prevCycle?.status === 'PENDING_PAYMENT'
        ? (prevCycle.consecutiveUnpaidCount ?? 0)
        : 0;
      const consecutiveUnpaidCount = overageAmount > 0 ? prevUnpaidCount + 1 : 0;

      const cycleStatus = overageAmount > 0 ? 'PENDING_PAYMENT' : 'CLOSED';
      const cycleId = uuidv4();

      const cycle: BillingCycleRecord = {
        PK: `USER#${sub.userId}`,
        SK: `CYCLE#${period}#${cycleId}`,
        entity: 'billing_cycle',
        cycleId,
        userId: sub.userId,
        subscriptionId: sub.subscriptionId,
        period,
        startDate,
        endDate,
        status: cycleStatus,
        frozenUsage: usageMap,
        includedLimits: limits,
        overageUnits,
        overageAmount,
        overageCurrency: OVERAGE_CURRENCY,
        consecutiveUnpaidCount,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };

      const written = await createBillingCycle(cycle);
      if (!written) {
        logger.info({ userId: sub.userId, period }, 'monthly-close: cycle already exists (idempotent skip)');
        skipped++;
        continue;
      }

      if (cycleStatus === 'PENDING_PAYMENT') {
        pendingPayment++;
        logger.info({
          userId: sub.userId,
          period,
          overageAmount,
          consecutiveUnpaidCount,
        }, 'monthly-close: PENDING_PAYMENT cycle created');

        // C2 policy: 2 consecutive unpaid cycles → downgrade to manual mode
        if (consecutiveUnpaidCount >= 2) {
          try {
            await updateSubscriptionStatus(sub.userId, 'DOWNGRADED_TO_MANUAL', sub.status, {
              downgradeReason: 'OVERAGE_NON_PAYMENT',
            });
            logger.warn(
              { userId: sub.userId, consecutiveUnpaidCount },
              'monthly-close: downgraded to DOWNGRADED_TO_MANUAL — 2 consecutive unpaid cycles',
            );
          } catch (err) {
            if (err instanceof ConditionalCheckFailedException) {
              logger.info({ userId: sub.userId }, 'monthly-close: C2 downgrade skipped — status already changed');
            } else {
              throw err;
            }
          }
        }
      } else {
        closed++;
        logger.info({ userId: sub.userId, period }, 'monthly-close: CLOSED cycle created');
      }
    } catch (err) {
      errors++;
      logger.error({ userId: sub.userId, err }, 'monthly-close: error processing subscription');
    }
  }

  logger.info({ period, closed, pendingPayment, skipped, errors }, 'monthly-close: done');
};
