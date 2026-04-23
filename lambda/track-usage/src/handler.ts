import type { APIGatewayProxyHandler } from 'aws-lambda';
import { resolveAuthContext } from '../../shared/src/auth-context';
import {
  toHttpResponse,
  NotFoundError,
  ValidationError,
} from '../../shared/src/errors';
import { logger } from '../../shared/src/logger';
import {
  getSubscription,
  getUsage,
  incrementUsage,
} from '../../shared/src/ddb-repo';
import {
  assertSubscriptionAccess,
  checkFeatureAllowance,
} from '../../shared/src/feature-gate';

// Feature key format: lowercase letters, digits, underscores. 2–64 chars.
// Must match the keys used in plan.limits (e.g. "chatbot_messages", "ai_generations").
const VALID_FEATURE = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * POST /subscriptions/me/usage/{feature}
 *
 * Generic usage tracking endpoint — project-agnostic.
 * Called by any project's BFF proxy before consuming a metered feature.
 * Atomically checks and increments the usage counter for the given feature
 * within the current subscription period.
 *
 * The {feature} path parameter must match a key in plan.limits.
 * Examples: "chatbot_messages", "ai_generations", "reports_generated"
 *
 * Usage is tracked per subscriptionId (not per calendar month), so a new
 * payment (new subscriptionId) resets all counters to 0 automatically.
 *
 * Response 200: { allowed: true,  remaining: N, limit: N, used: N }
 * Response 429: { allowed: false, remaining: 0, limit: N, used: N }
 * Response 400: invalid or missing feature name
 * Response 403: subscription inactive or not found
 * Response 404: no subscription found for the authenticated user
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const { userId } = await resolveAuthContext(event);

    // 1. Validate and extract feature from path parameter
    const feature = event.pathParameters?.feature;
    if (!feature || !VALID_FEATURE.test(feature)) {
      throw new ValidationError(
        'feature path parameter must be lowercase alphanumeric with underscores (e.g. "chatbot_messages")',
      );
    }

    // Optional quantity from body (e.g. scribe_minutes sends actual minutes consumed)
    let quantity = 1;
    if (event.body) {
      try {
        const body = JSON.parse(event.body);
        if (typeof body.quantity === 'number' && body.quantity > 0) {
          quantity = Math.ceil(body.quantity);
        }
      } catch {
        // Malformed body — fall back to quantity=1
      }
    }

    logger.info('track-usage: request', { userId, feature, quantity });

    // 2. Load subscription
    const sub = await getSubscription(userId);
    if (!sub) throw new NotFoundError('Subscription');

    // 3. Verify subscription is active (throws 403 if not)
    assertSubscriptionAccess(sub);

    // 4. Resolve limit from plan cache. 0 means feature not included in plan.
    const limit = sub.limitsCached?.[feature] ?? 0;

    // 5. Read current usage for this subscription period
    const currentUsage = await getUsage(userId, feature, sub.subscriptionId);

    // 6. Check allowance — always allows (overage accumulates, billed at month close)
    const check = checkFeatureAllowance(sub, feature, currentUsage);

    // 7. Atomically increment — returns new count
    const newCount = await incrementUsage(userId, feature, sub.subscriptionId, quantity);

    logger.info('track-usage: usage recorded', {
      userId,
      subscriptionId: sub.subscriptionId,
      feature,
      used: newCount,
      limit,
      overage: check.overage,
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        allowed:      true,
        overage:      check.overage,
        overageUnits: check.overage ? newCount - limit : 0,
        remaining:    Math.max(0, limit - newCount),
        limit,
        used:         newCount,
      }),
    };
  } catch (error) {
    logger.error('track-usage error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return toHttpResponse(error);
  }
};
