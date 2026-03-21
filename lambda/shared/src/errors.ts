import type { APIGatewayProxyResult } from 'aws-lambda';
import { logger } from './logger';

// ─── Base Error ───────────────────────────────────────────────────────────────

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'AppError';
    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── Typed Errors ─────────────────────────────────────────────────────────────

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(401, message, 'UNAUTHORIZED');
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(404, `${resource} not found`, 'NOT_FOUND');
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, message, 'CONFLICT');
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, message, 'VALIDATION_ERROR');
  }
}

export class PaymentProviderError extends AppError {
  constructor(message: string, public readonly providerCode?: string) {
    super(502, message, 'PAYMENT_PROVIDER_ERROR');
  }
}

export class FeatureLimitExceededError extends AppError {
  constructor(feature: string, limit: number) {
    super(429, `Feature limit exceeded: ${feature} (limit: ${limit})`, 'FEATURE_LIMIT_EXCEEDED');
  }
}

export class SubscriptionInactiveError extends AppError {
  constructor(status: string) {
    super(403, `Subscription is not active (status: ${status})`, 'SUBSCRIPTION_INACTIVE');
  }
}

// ─── HTTP Response Helper ─────────────────────────────────────────────────────

/**
 * Converts any error into a safe APIGatewayProxyResult.
 * Never leaks internal details for 5xx errors.
 */
export function toHttpResponse(error: unknown): APIGatewayProxyResult {
  if (error instanceof AppError) {
    logger.warn('Request error', { code: error.code, message: error.message, statusCode: error.statusCode });
    return {
      statusCode: error.statusCode,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message, code: error.code }),
    };
  }

  // Unknown/unexpected errors — log full details but return generic message
  logger.error('Unhandled error', { error: error instanceof Error ? error.message : String(error) });
  return {
    statusCode: 500,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: 'Internal server error', code: 'INTERNAL_ERROR' }),
  };
}
