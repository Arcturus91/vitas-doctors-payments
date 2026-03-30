import type { DynamoDBStreamHandler, DynamoDBRecord } from 'aws-lambda';
import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';
import { logger } from '../../shared/src/logger';

const ebClient = new EventBridgeClient({});

/**
 * DynamoDB Stream-triggered Lambda — subscription lifecycle side-effects.
 *
 * Triggered by: NEW_AND_OLD_IMAGES stream on SaasCore_Table
 *
 * Responsibilities:
 *   - Detect subscription status changes (old.status !== new.status)
 *   - Detect new payment inserts (eventName = INSERT, entity = payment)
 *   - Publish EventBridge events when ENABLE_EVENT_BRIDGE=true
 *
 * Filtering (Lambda-level DDB filter also configured in the construct):
 *   - entity = 'subscription' or 'payment'
 *   - eventName = INSERT or MODIFY (REMOVE is ignored)
 *
 * Note: full rehydration of limitsCached (when a plan changes) is a future
 *       enhancement — the plan is immutable once a subscription is created,
 *       so stale limitsCached is not a concern in the current design.
 */
export const handler: DynamoDBStreamHandler = async (event) => {
  logger.info('subscription-events-processor: invoked', {
    recordCount: event.Records.length,
  });

  for (const record of event.Records) {
    await processRecord(record);
  }
};

async function processRecord(record: DynamoDBRecord): Promise<void> {
  // Ignore deletes — we never delete subscription or payment records
  if (record.eventName === 'REMOVE') return;

  try {
    const entity = record.dynamodb?.NewImage?.entity?.S;
    if (!entity) return;

    if (entity === 'subscription') {
      await processSubscriptionChange(record);
    } else if (entity === 'payment') {
      await processPaymentInsert(record);
    }
  } catch (error) {
    logger.error('subscription-events-processor: record failed', {
      eventID: record.eventID,
      error:   error instanceof Error ? error.message : String(error),
    });
    // Re-throw → Lambda retries with bisectBatchOnError
    throw error;
  }
}

// ─── Subscription change ───────────────────────────────────────────────────

async function processSubscriptionChange(record: DynamoDBRecord): Promise<void> {
  const newImage = record.dynamodb?.NewImage;
  const oldImage = record.dynamodb?.OldImage;

  const newStatus = newImage?.status?.S;
  const oldStatus = oldImage?.status?.S;
  const userId    = newImage?.userId?.S;
  const subId     = newImage?.subscriptionId?.S;
  const doctorId  = newImage?.doctorId?.S;

  // Only act when the status actually changed
  if (!newStatus || newStatus === oldStatus) return;

  logger.info('subscription-events-processor: status changed', {
    userId, subscriptionId: subId, oldStatus, newStatus, eventName: record.eventName,
  });

  // Emit EventBridge event when ENABLE_EVENT_BRIDGE=true.
  // Consuming projects (e.g. vitas-main-stack) subscribe to this event to apply
  // their own post-payment side-effects (feature activation, notifications, etc.).
  if (process.env.ENABLE_EVENT_BRIDGE === 'true') {
    await publishEvent('subscription.status.changed', {
      userId,
      subscriptionId: subId,
      // doctorId is included when present so consumers can avoid a Users_Table lookup
      ...(doctorId ? { doctorId } : {}),
      oldStatus,
      newStatus,
      changedAt: new Date().toISOString(),
    });
  }
}

// ─── Payment insert ────────────────────────────────────────────────────────

async function processPaymentInsert(record: DynamoDBRecord): Promise<void> {
  // Only act on new payment records, not updates
  if (record.eventName !== 'INSERT') return;

  const newImage = record.dynamodb?.NewImage;
  const userId    = newImage?.PK?.S?.replace('USER#', '');
  const paymentId = newImage?.paymentId?.S;
  const status    = newImage?.status?.S;
  const amount    = newImage?.amount?.N;
  const currency  = newImage?.currency?.S;

  logger.info('subscription-events-processor: new payment', {
    userId, paymentId, status,
  });

  if (process.env.ENABLE_EVENT_BRIDGE === 'true') {
    await publishEvent('payment.created', {
      userId,
      paymentId,
      status,
      amount:    amount ? Number(amount) : undefined,
      currency,
      createdAt: new Date().toISOString(),
    });
  }
}

// ─── EventBridge helper ────────────────────────────────────────────────────

async function publishEvent(
  detailType: string,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await ebClient.send(new PutEventsCommand({
      Entries: [{
        Source:       process.env.SERVICE_NAME ?? 'payments-module',
        DetailType:   detailType,
        Detail:       JSON.stringify(detail),
        EventBusName: 'default',
      }],
    }));
    logger.debug('subscription-events-processor: EventBridge event published', { detailType });
  } catch (err) {
    // EventBridge failures must not block stream processing — log and move on
    logger.error('subscription-events-processor: EventBridge publish failed', {
      detailType,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
