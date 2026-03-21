import type { APIGatewayProxyHandler } from 'aws-lambda';
import { resolveAuthContext } from '../../shared/src/auth-context';
import { toHttpResponse, NotFoundError } from '../../shared/src/errors';
import { logger } from '../../shared/src/logger';
import { getSubscription } from '../../shared/src/ddb-repo';

/**
 * GET /subscriptions/me
 *
 * Returns the authenticated user's subscription details.
 * Strips internal DynamoDB keys (PK, SK, GSI keys) from the response.
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  try {
    const { userId } = await resolveAuthContext(event);

    logger.info('get-subscription: request', { userId });

    const sub = await getSubscription(userId);
    if (!sub) throw new NotFoundError('Subscription');

    // Strip internal DynamoDB / GSI keys — never expose them to clients
    const {
      PK: _pk,
      SK: _sk,
      GSI1PK: _gsi1pk,
      GSI1SK: _gsi1sk,
      ...publicSubscription
    } = sub;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(publicSubscription),
    };
  } catch (error) {
    logger.error('get-subscription error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return toHttpResponse(error);
  }
};
