import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { logger } from './logger';

const client = new SecretsManagerClient({});

// Simple in-memory cache to avoid redundant Secrets Manager calls during warm Lambda invocations.
// Cache TTL: 5 minutes — secrets rotate rarely but we don't want stale tokens.
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { value: string; expiresAt: number }>();

/**
 * Fetch a secret string from AWS Secrets Manager with in-memory caching.
 * The ARN is read from the environment variable name provided.
 *
 * Usage:
 *   const token = await getSecret('MP_SECRET_ARN');
 *
 * The secret value is expected to be a JSON string:
 *   { "access_token": "...", "client_id": "...", "client_secret": "..." }
 */
export async function getSecret(envVarName: string): Promise<string> {
  const secretArn = process.env[envVarName];
  if (!secretArn) {
    throw new Error(`Environment variable "${envVarName}" is not set — cannot resolve secret ARN`);
  }

  const cached = cache.get(secretArn);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  logger.debug('Fetching secret from Secrets Manager', { secretArn });

  const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));

  if (!response.SecretString) {
    throw new Error(`Secret "${secretArn}" has no SecretString value`);
  }

  cache.set(secretArn, { value: response.SecretString, expiresAt: Date.now() + CACHE_TTL_MS });
  return response.SecretString;
}

/**
 * Parse the MercadoPago secret JSON and return the access token.
 * Secret format: { "access_token": "APP_USR-...", "client_id": "...", "client_secret": "..." }
 */
export async function getMercadoPagoAccessToken(): Promise<string> {
  const secretJson = await getSecret('MP_SECRET_ARN');
  const parsed = JSON.parse(secretJson) as { access_token?: string };
  if (!parsed.access_token) {
    throw new Error('MercadoPago secret is missing "access_token" field');
  }
  return parsed.access_token;
}
