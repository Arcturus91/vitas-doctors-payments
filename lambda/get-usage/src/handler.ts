import type { APIGatewayProxyHandler } from 'aws-lambda';
import { resolveAuthContext } from '../../shared/src/auth-context';
import { toHttpResponse, NotFoundError } from '../../shared/src/errors';
import { logger } from '../../shared/src/logger';
import { getSubscription, getAllUsageForSubscription } from '../../shared/src/ddb-repo';

/**
 * GET /subscriptions/me/usage
 *
 * Returns the authenticated user's current subscription usage for all metered features.
 * Used by the subscription page to render usage bars and overage warnings.
 *
 * Response 200:
 * {
 *   "period": "2026-04",   // YYYY-MM of the current period (subscription start month)
 *   "usage": {
 *     "chatbot_messages": { "used": 45, "limit": 200, "overage": false, "overageUnits": 0 },
 *     "scribe_minutes":   { "used": 210, "limit": 200, "overage": true, "overageUnits": 10 }
 *   }
 * }
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const { userId } = await resolveAuthContext(event);
    logger.info('get-usage: request', { userId });

    const sub = await getSubscription(userId);
    if (!sub) throw new NotFoundError('Subscription');

    const usageMap = await getAllUsageForSubscription(userId, sub.subscriptionId);

    // Build per-feature breakdown using plan limits from limitsCached
    const usage: Record<string, {
      used: number;
      limit: number;
      overage: boolean;
      overageUnits: number;
    }> = {};

    for (const [feature, limit] of Object.entries(sub.limitsCached ?? {})) {
      const used = usageMap[feature] ?? 0;
      const overage = limit !== -1 && used > limit;
      usage[feature] = {
        used,
        limit,
        overage,
        overageUnits: overage ? used - limit : 0,
      };
    }

    // Derive period from subscription creation date (YYYY-MM)
    const period = sub.createdAt.substring(0, 7);

    logger.info('get-usage: returning', { userId, period, featureCount: Object.keys(usage).length });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ period, usage }),
    };
  } catch (error) {
    logger.error('get-usage error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return toHttpResponse(error);
  }
};
