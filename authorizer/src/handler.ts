import type {
  APIGatewayTokenAuthorizerHandler,
  APIGatewayAuthorizerResult,
} from 'aws-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import * as jwt from 'jsonwebtoken';

const ssm = new SSMClient({});

// Simple in-memory cache — avoids an SSM call on every API request (5-min TTL)
let cachedSecret: string | null = null;
let cacheExpiry = 0;

async function getJwtSecret(): Promise<string> {
  if (cachedSecret && Date.now() < cacheExpiry) return cachedSecret;

  const result = await ssm.send(new GetParameterCommand({
    Name:            process.env.JWT_SECRET_PARAM ?? '/vitas/auth/jwt-secret',
    WithDecryption:  true,
  }));

  cachedSecret = result.Parameter?.Value ?? '';
  cacheExpiry  = Date.now() + 5 * 60 * 1000; // 5 minutes
  return cachedSecret;
}

/**
 * API Gateway TOKEN authorizer for the Vitas payments module.
 *
 * Validates the JWT issued by vitas-auth and injects userId into the
 * authorizer context so Lambda handlers can read it via resolveAuthContext():
 *   event.requestContext.authorizer.userId
 *
 * The JWT payload uses the field "user_id" (set by vitas-auth).
 * The secret is stored in SSM at /vitas/auth/jwt-secret.
 */
export const handler: APIGatewayTokenAuthorizerHandler = async (event) => {
  // Strip "Bearer " prefix if present
  const token = event.authorizationToken?.replace(/^Bearer\s+/i, '').trim();

  if (!token) {
    // API Gateway treats this Error message as a 401
    throw new Error('Unauthorized');
  }

  try {
    const secret  = await getJwtSecret();
    const decoded = jwt.verify(token, secret) as Record<string, unknown>;

    // Vitas JWT payload uses "user_id" — fall back to "userId" / "sub" for future-proofing
    const userId = String(decoded['user_id'] ?? decoded['userId'] ?? decoded['sub'] ?? '');

    if (!userId) {
      throw new Error('Token missing user_id claim');
    }

    return buildPolicy('Allow', event.methodArn, userId);
  } catch {
    throw new Error('Unauthorized');
  }
};

function buildPolicy(
  effect:   'Allow' | 'Deny',
  resource: string,
  userId:   string,
): APIGatewayAuthorizerResult {
  return {
    principalId: userId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{
        Action:   'execute-api:Invoke',
        Effect:   effect,
        // Wildcard the method ARN so the cached policy covers all subscription routes
        Resource: resource.replace(/\/[^/]+\/[^/]+$/, '/*/*'),
      }],
    },
    context: {
      // This is what resolveAuthContext(event) reads in each Lambda handler
      userId,
    },
  };
}
