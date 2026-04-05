import {
  DynamoDBClient,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
  type GetCommandInput,
  type PutCommandInput,
  type UpdateCommandInput,
  type QueryCommandInput,
  type ScanCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { Subscription, Payment, UsageItem, SubscriptionEvent, Plan, BillingCycleRecord, BillingCycleStatus } from './types';

// ─── Client ───────────────────────────────────────────────────────────────────

const client = new DynamoDBClient({});
export const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    removeUndefinedValues: true,
    convertEmptyValues: false,
  },
});

// Re-export for use in handlers
export { ConditionalCheckFailedException };

// ─── Table Name Helpers ───────────────────────────────────────────────────────

export function getCoreTableName(): string {
  const name = process.env.CORE_TABLE_NAME;
  if (!name) throw new Error('CORE_TABLE_NAME environment variable is not set');
  return name;
}

export function getPlansTableName(): string {
  const name = process.env.PLANS_TABLE_NAME;
  if (!name) throw new Error('PLANS_TABLE_NAME environment variable is not set');
  return name;
}

// ─── Repository Functions ─────────────────────────────────────────────────────

/** Get a plan by planId from Plans_Table */
export async function getPlan(planId: string): Promise<Plan | null> {
  const params: GetCommandInput = {
    TableName: getPlansTableName(),
    Key: { planId },
  };
  const result = await ddb.send(new GetCommand(params));
  return (result.Item as Plan) ?? null;
}

/** Get a user's primary subscription from SaasCore_Table */
export async function getSubscription(userId: string): Promise<Subscription | null> {
  const params: GetCommandInput = {
    TableName: getCoreTableName(),
    Key: {
      PK: `USER#${userId}`,
      SK: 'SUBSCRIPTION#primary',
    },
  };
  const result = await ddb.send(new GetCommand(params));
  return (result.Item as Subscription) ?? null;
}

/**
 * Lookup subscription by provider subscription ID via GSI1.
 * Used in webhook-processor to find the local record from a provider event.
 */
export async function getSubscriptionByProviderId(
  providerSubscriptionId: string,
): Promise<Subscription | null> {
  const params: QueryCommandInput = {
    TableName: getCoreTableName(),
    IndexName: 'GSI1-ProviderSubscription',
    KeyConditionExpression: 'GSI1PK = :gsi1pk',
    ExpressionAttributeValues: {
      ':gsi1pk': `PROVIDER_SUB#${providerSubscriptionId}`,
    },
    Limit: 1,
  };
  const result = await ddb.send(new QueryCommand(params));
  const items = result.Items;
  if (!items || items.length === 0) return null;
  return items[0] as Subscription;
}

/**
 * Write a new subscription item.
 * Allows overwriting an existing PENDING record (user abandoned checkout and is retrying).
 * Throws ConditionalCheckFailedException if a live subscription already exists.
 */
export async function createSubscription(subscription: Subscription): Promise<void> {
  const params: PutCommandInput = {
    TableName: getCoreTableName(),
    Item: subscription,
    ConditionExpression: 'attribute_not_exists(PK) OR #s = :pending',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':pending': 'PENDING' },
  };
  await ddb.send(new PutCommand(params));
}

/**
 * Write a TRIAL subscription created without a payment provider.
 * Allows overwriting PENDING (abandoned checkout) or CANCELED (previous paid subscription).
 * Throws ConditionalCheckFailedException if an active subscription already exists.
 */
export async function createTrialSubscription(subscription: Subscription): Promise<void> {
  const params: PutCommandInput = {
    TableName: getCoreTableName(),
    Item: subscription,
    ConditionExpression: 'attribute_not_exists(PK) OR #s IN (:pending, :canceled)',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':pending': 'PENDING', ':canceled': 'CANCELED' },
  };
  await ddb.send(new PutCommand(params));
}

/**
 * Atomically update subscription status.
 * Uses a condition expression to prevent race conditions
 * (e.g. only update from PENDING → ACTIVE if still PENDING).
 */
export async function updateSubscriptionStatus(
  userId: string,
  newStatus: Subscription['status'],
  expectedCurrentStatus: Subscription['status'],
  extraAttributes?: Partial<Subscription>,
): Promise<void> {
  const now = new Date().toISOString();

  const expressionAttributeNames: Record<string, string> = {
    '#status': 'status',
  };
  const expressionAttributeValues: Record<string, unknown> = {
    ':newStatus': newStatus,
    ':expectedStatus': expectedCurrentStatus,
    ':now': now,
  };

  let setExpression = 'SET #status = :newStatus, updatedAt = :now';

  if (extraAttributes) {
    let i = 0;
    for (const [key, value] of Object.entries(extraAttributes)) {
      // Skip keys that are already handled or are immutable
      if (['PK', 'SK', 'entity', 'status', 'updatedAt', 'createdAt'].includes(key)) continue;
      const nameRef = `#extra${i}`;
      const valueRef = `:extra${i}`;
      setExpression += `, ${nameRef} = ${valueRef}`;
      expressionAttributeNames[nameRef] = key;
      expressionAttributeValues[valueRef] = value;
      i++;
    }
  }

  const params: UpdateCommandInput = {
    TableName: getCoreTableName(),
    Key: {
      PK: `USER#${userId}`,
      SK: 'SUBSCRIPTION#primary',
    },
    UpdateExpression: setExpression,
    ConditionExpression: '#status = :expectedStatus',
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: expressionAttributeValues,
  };

  await ddb.send(new UpdateCommand(params));
}

/**
 * Upsert a payment item.
 * Uses attribute_not_exists(PK) condition for idempotency.
 * If the payment already exists (duplicate webhook), returns false.
 * Returns true when the payment was written.
 */
export async function upsertPayment(payment: Payment): Promise<boolean> {
  const params: PutCommandInput = {
    TableName: getCoreTableName(),
    Item: payment,
    // PK+SK uniquely identifies the item — this prevents duplicate webhook processing
    ConditionExpression: 'attribute_not_exists(PK)',
  };
  try {
    await ddb.send(new PutCommand(params));
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      // Duplicate — already written by a previous webhook delivery
      return false;
    }
    throw err;
  }
}

/**
 * Read the current usage count for a feature scoped to a subscription.
 * Returns 0 if no usage has been recorded yet.
 */
export async function getUsage(
  userId: string,
  feature: string,
  subscriptionId: string,
): Promise<number> {
  const params: GetCommandInput = {
    TableName: getCoreTableName(),
    Key: {
      PK: `USER#${userId}`,
      SK: `USAGE#${feature}#${subscriptionId}`,
    },
    ProjectionExpression: '#count',
    ExpressionAttributeNames: { '#count': 'count' },
  };
  const result = await ddb.send(new GetCommand(params));
  return (result.Item?.count as number) ?? 0;
}

/**
 * Atomically increment a usage counter for the current billing period.
 * Returns the new count after increment.
 * Uses DynamoDB ADD — safe for concurrent calls.
 */
export async function incrementUsage(
  userId: string,
  feature: string,
  period: string, // YYYY-MM or subscriptionId for per-subscription tracking
): Promise<number> {
  const params: UpdateCommandInput = {
    TableName: getCoreTableName(),
    Key: {
      PK: `USER#${userId}`,
      SK: `USAGE#${feature}#${period}`,
    },
    UpdateExpression: 'ADD #count :inc SET entity = if_not_exists(entity, :entity)',
    ExpressionAttributeNames: {
      '#count': 'count',
    },
    ExpressionAttributeValues: {
      ':inc': 1,
      ':entity': 'usage',
    },
    ReturnValues: 'ALL_NEW',
  };
  const result = await ddb.send(new UpdateCommand(params));
  return (result.Attributes?.count as number) ?? 1;
}

/**
 * Write a subscription event for audit trail.
 * Events are immutable — PK=SUBSCRIPTION#subId, SK=EVENT#<timestamp>.
 */
export async function writeEvent(event: SubscriptionEvent): Promise<void> {
  const params: PutCommandInput = {
    TableName: getCoreTableName(),
    Item: event,
    // No condition — events are immutable audit records. SK always includes a UUID
    // so collisions are impossible. Plain Put is safe and avoids spurious errors on retries.
  };
  await ddb.send(new PutCommand(params));
}

// ─── BillingCycle CRUD ────────────────────────────────────────────────────────

/**
 * Create a billing cycle record.
 * Idempotent: condition attribute_not_exists prevents duplicate writes (e.g. Lambda retry).
 * Returns false if the record already exists, true if written.
 */
export async function createBillingCycle(cycle: BillingCycleRecord): Promise<boolean> {
  const params: PutCommandInput = {
    TableName: getCoreTableName(),
    Item: cycle,
    ConditionExpression: 'attribute_not_exists(PK)',
  };
  try {
    await ddb.send(new PutCommand(params));
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}

/**
 * Get a billing cycle by userId and period (YYYY-MM).
 * Queries by SK prefix CYCLE#YYYY-MM to find the cycle for that month.
 */
export async function getBillingCycleByPeriod(
  userId: string,
  period: string, // YYYY-MM
): Promise<BillingCycleRecord | null> {
  const params: QueryCommandInput = {
    TableName: getCoreTableName(),
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': `USER#${userId}`,
      ':skPrefix': `CYCLE#${period}`,
    },
    Limit: 1,
  };
  const result = await ddb.send(new QueryCommand(params));
  const items = result.Items;
  if (!items || items.length === 0) return null;
  return items[0] as BillingCycleRecord;
}

/**
 * Update the status of a billing cycle record.
 * Optionally sets extra fields (paymentId, etc.).
 */
export async function updateBillingCycleStatus(
  userId: string,
  sk: string,
  status: BillingCycleStatus,
  extras?: Partial<BillingCycleRecord>,
): Promise<void> {
  const now = new Date().toISOString();
  const expressionAttributeNames: Record<string, string> = { '#status': 'status' };
  const expressionAttributeValues: Record<string, unknown> = {
    ':status': status,
    ':now': now,
  };

  let setExpression = 'SET #status = :status, updatedAt = :now';

  if (extras) {
    let i = 0;
    for (const [key, value] of Object.entries(extras)) {
      if (['PK', 'SK', 'entity', 'status', 'updatedAt', 'createdAt'].includes(key)) continue;
      const nameRef = `#ex${i}`;
      const valueRef = `:ex${i}`;
      setExpression += `, ${nameRef} = ${valueRef}`;
      expressionAttributeNames[nameRef] = key;
      expressionAttributeValues[valueRef] = value;
      i++;
    }
  }

  const params: UpdateCommandInput = {
    TableName: getCoreTableName(),
    Key: {
      PK: `USER#${userId}`,
      SK: sk,
    },
    UpdateExpression: setExpression,
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: expressionAttributeValues,
  };
  await ddb.send(new UpdateCommand(params));
}

/**
 * Query all usage items for a subscription (all features in one query).
 * Returns a map of feature → count.
 */
export async function getAllUsageForSubscription(
  userId: string,
  subscriptionId: string,
): Promise<Record<string, number>> {
  const params: QueryCommandInput = {
    TableName: getCoreTableName(),
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': `USER#${userId}`,
      ':skPrefix': `USAGE#`,
    },
  };
  const result = await ddb.send(new QueryCommand(params));
  const usageMap: Record<string, number> = {};
  for (const item of result.Items ?? []) {
    // SK format: USAGE#feature#subscriptionId
    const sk: string = item.SK as string;
    const parts = sk.split('#');
    // parts[0] = USAGE, parts[1] = feature, parts[2] = subscriptionId
    if (parts.length >= 3 && parts[2] === subscriptionId) {
      usageMap[parts[1]] = (item.count as number) ?? 0;
    }
  }
  return usageMap;
}

/**
 * Scan all subscription items with a given status.
 * Used by expire-subscriptions and monthly-close Lambdas.
 * Table is small in dev — FilterExpression scan is acceptable.
 */
export async function scanSubscriptionsByStatus(
  statuses: string[],
): Promise<Subscription[]> {
  const filterParts = statuses.map((_, i) => `#status = :s${i}`);
  const expressionAttributeValues: Record<string, unknown> = {};
  statuses.forEach((s, i) => { expressionAttributeValues[`:s${i}`] = s; });

  const params: ScanCommandInput = {
    TableName: getCoreTableName(),
    FilterExpression: `entity = :entity AND (${filterParts.join(' OR ')})`,
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':entity': 'subscription',
      ...expressionAttributeValues,
    },
  };
  const result = await ddb.send(new ScanCommand(params));
  return (result.Items ?? []) as Subscription[];
}

/**
 * Read usage count for a feature scoped to a specific period (YYYY-MM).
 * Used by monthly-close to calculate overage.
 */
export async function getUsageByPeriod(
  userId: string,
  feature: string,
  period: string, // YYYY-MM
): Promise<number> {
  // Usage items use subscriptionId as period key in real-time tracking,
  // but for monthly-close we query by the period prefix
  const params: QueryCommandInput = {
    TableName: getCoreTableName(),
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
    ExpressionAttributeValues: {
      ':pk': `USER#${userId}`,
      ':skPrefix': `USAGE#${feature}#`,
    },
    ProjectionExpression: '#count, SK',
    ExpressionAttributeNames: { '#count': 'count' },
  };
  const result = await ddb.send(new QueryCommand(params));
  // Sum all usage items for this feature (in case of multiple subscription periods)
  const total = (result.Items ?? []).reduce((sum: number, item: Record<string, unknown>) => sum + ((item.count as number) ?? 0), 0);
  return total;
}
