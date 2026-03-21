import { createHmac, timingSafeEqual } from 'crypto';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { UnauthorizedError } from './errors';
import type { AuthContext } from './types';

// ─── SSM secret cache (module-level, same pattern as vitas-main-stack) ────────

const ssm = new SSMClient({});

let cachedSecret: string | null = null;
let cacheExpiry = 0;

async function getJwtSecret(): Promise<string> {
  if (cachedSecret && Date.now() < cacheExpiry) return cachedSecret;

  const result = await ssm.send(new GetParameterCommand({
    Name:           process.env.JWT_SECRET_PARAM ?? '/vitas/auth/jwt-secret',
    WithDecryption: true,
  }));

  cachedSecret = result.Parameter?.Value ?? '';
  cacheExpiry  = Date.now() + 5 * 60 * 1000; // 5-minute cache
  return cachedSecret;
}

// ─── Lightweight HS256 JWT verification using Node.js built-in crypto ─────────
// Uses only crypto (Node built-in) + @aws-sdk/client-ssm (Lambda runtime).
// No extra npm packages required — same approach as vitas-main-stack.

function base64UrlDecode(str: string): string {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function verifyJwt(token: string, secret: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT format');

  const [headerB64, payloadB64, signatureB64] = parts;

  // Re-compute expected signature
  const expectedSig = createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');

  // Timing-safe comparison (prevents timing attacks)
  const expectedBuf = Buffer.from(expectedSig);
  const actualBuf   = Buffer.from(signatureB64);

  if (
    expectedBuf.length !== actualBuf.length ||
    !timingSafeEqual(expectedBuf, actualBuf)
  ) {
    throw new Error('Invalid JWT signature');
  }

  const payload = JSON.parse(base64UrlDecode(payloadB64)) as Record<string, unknown>;

  // Check expiry
  const exp = payload['exp'];
  if (typeof exp === 'number' && Date.now() / 1000 > exp) {
    throw new Error('JWT expired');
  }

  return payload;
}

// ─── resolveAuthContext ────────────────────────────────────────────────────────
//
// Validates the JWT from the Authorization header directly inside the Lambda —
// the same pattern used by vitas-main-stack (no API Gateway TOKEN authorizer).
//
// Falls back to requestContext.authorizer.userId for compatibility with
// deployments that DO attach a TOKEN authorizer.

export async function resolveAuthContext(event: APIGatewayProxyEvent): Promise<AuthContext> {
  // ── Fallback: authorizer context (TOKEN authorizer, if present) ───────────
  const authorizerUserId = event.requestContext?.authorizer?.userId as string | undefined;
  if (authorizerUserId && authorizerUserId.trim()) {
    return { userId: authorizerUserId.trim() };
  }

  // ── Primary: validate JWT from Authorization header ───────────────────────
  const authHeader = event.headers?.Authorization ?? event.headers?.authorization ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  if (!token) {
    throw new UnauthorizedError('Authorization header is required');
  }

  try {
    const secret  = await getJwtSecret();
    const payload = verifyJwt(token, secret);

    // Vitas JWT payload uses "user_id" (snake_case) — matches vitas-auth Lambda
    const userId = String(payload['user_id'] ?? payload['userId'] ?? payload['sub'] ?? '');

    if (!userId || userId === 'undefined') {
      throw new UnauthorizedError('Token missing user_id claim');
    }

    return { userId };
  } catch (err) {
    throw new UnauthorizedError(
      err instanceof UnauthorizedError ? err.message : 'Invalid or expired token',
    );
  }
}
