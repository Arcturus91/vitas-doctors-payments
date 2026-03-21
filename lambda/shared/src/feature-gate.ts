import type { Subscription, FeatureCheckResult } from './types';
import { FeatureLimitExceededError, SubscriptionInactiveError } from './errors';

/**
 * Checks whether a subscription has valid access (ACTIVE, TRIAL within period, or PAST_DUE within grace).
 * Throws SubscriptionInactiveError if access should be denied.
 *
 * Access rules:
 *   ACTIVE         → always allowed
 *   TRIAL          → allowed if now < trialEndsAt
 *   PAST_DUE       → allowed if now < graceEndsAt
 *   PENDING_CANCEL → allowed (user retains access until period ends)
 *   CANCELED       → denied
 *   PENDING        → denied (awaiting first payment)
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

    default:
      throw new SubscriptionInactiveError(subscription.status);
  }
}

/**
 * Checks whether a feature is within its usage limit for the current period.
 * Does NOT increment the counter — use ddb-repo.incrementUsage for that.
 *
 * Returns a FeatureCheckResult with allowed, remaining, limit, and current values.
 * Throws FeatureLimitExceededError if limit is exceeded and enforce=true.
 *
 * A limit of -1 means unlimited (no cap enforced).
 */
export function checkFeatureAllowance(
  subscription: Subscription,
  feature: string,
  currentUsage: number,
  enforce = false,
): FeatureCheckResult {
  const limit = subscription.limitsCached[feature] ?? 0;

  // -1 sentinel means unlimited
  if (limit === -1) {
    return { allowed: true, remaining: Infinity, limit, current: currentUsage };
  }

  const allowed = currentUsage < limit;
  const remaining = Math.max(0, limit - currentUsage);

  if (!allowed && enforce) {
    throw new FeatureLimitExceededError(feature, limit);
  }

  return { allowed, remaining, limit, current: currentUsage };
}
