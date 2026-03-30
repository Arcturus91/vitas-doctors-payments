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
  type GetCommandInput,
  type PutCommandInput,
  type UpdateCommandInput,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { Subscription, Payment, UsageItem, SubscriptionEvent, Plan } from './types';

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
