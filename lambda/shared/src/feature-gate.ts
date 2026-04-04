import type { Subscription, FeatureCheckResult } from './types';
import { SubscriptionInactiveError } from './errors';

/**
 * Checks whether a subscription has valid access (ACTIVE, TRIAL within period, or PAST_DUE within grace).
 * Throws SubscriptionInactiveError if access should be denied.
 *
 * Access rules:
 *   ACTIVE               → always allowed
 *   TRIAL                → allowed if now < trialEndsAt
 *   PAST_DUE             → allowed if now < graceEndsAt
 *   PENDING_CANCEL       → allowed (user retains access until period ends)
 *   CANCELED             → denied
 *   PENDING              → denied (awaiting first payment)
 *   DOWNGRADED_TO_MANUAL → denied (trial/grace expired — AI paused)
 */
export function assertSubscriptionAccess(subscription: Subscription): void {
  const now = new Date().toISOString();

  switch (subscription.status) {
    case 'ACTIVE':
    case 'PENDING_CANCEL':
      // Always allowed
      return;

    case 'TRIAL':
      if (subscription.trialEndsAt && now < subscription.trialEndsAt) return;
      throw new SubscriptionInactiveError('TRIAL_EXPIRED');

    case 'PAST_DUE':
      if (subscription.graceEndsAt && now < subscription.graceEndsAt) return;
      throw new SubscriptionInactiveError('PAST_DUE_GRACE_EXPIRED');

    case 'CANCELED':
      throw new SubscriptionInactiveError('CANCELED');

    case 'PENDING':
      throw new SubscriptionInactiveError('PENDING');

    case 'DOWNGRADED_TO_MANUAL':
      throw new SubscriptionInactiveError('DOWNGRADED_TO_MANUAL');

    default:
      throw new SubscriptionInactiveError(subscription.status);
  }
}

/**
 * Checks feature usage against the plan limit.
 * Does NOT increment the counter — use ddb-repo.incrementUsage for that.
 *
 * Overage policy: usage is ALWAYS allowed when the plan includes overage_prices
 * for the feature. The overage flag and overageUnits are returned so callers can
 * surface usage warnings in the UI. Hard 429s are no longer returned from this
 * function — usage accumulates and is billed at monthly close.
 *
 * A limit of -1 means unlimited (no cap enforced).
 */
export function checkFeatureAllowance(
  subscription: Subscription,
  feature: string,
  currentUsage: number,
): FeatureCheckResult {
  const limit = subscription.limitsCached?.[feature] ?? 0;

  // -1 sentinel means unlimited
  if (limit === -1) {
    return { allowed: true, overage: false, overageUnits: 0, remaining: Infinity, limit, current: currentUsage };
  }

  const overage = currentUsage >= limit;
  const remaining = Math.max(0, limit - currentUsage);
  const overageUnits = overage ? currentUsage - limit + 1 : 0;

  // Always allow — overage accumulates and is billed at monthly close (C1 policy)
  return { allowed: true, overage, overageUnits, remaining, limit, current: currentUsage };
}
