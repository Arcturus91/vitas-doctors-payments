import type { SQSHandler, SQSRecord } from 'aws-lambda';
import {
  EventBridgeClient,
  PutEventsCommand,
} from '@aws-sdk/client-eventbridge';
import { logger } from '../../shared/src/logger';
import {
  getSubscription,
  getSubscriptionByProviderId,
  updateSubscriptionStatus,
  upsertPayment,
  writeEvent,
  ConditionalCheckFailedException,
} from '../../shared/src/ddb-repo';
import { getMercadoPagoAccessToken } from '../../shared/src/secrets';
import { providerFactory } from '../../shared/src/provider';
import type { Payment, Subscription } from '../../shared/src/types';

const ebClient = new EventBridgeClient({});

// ─── Types ─────────────────────────────────────────────────────────────────

/** Shape of the message enqueued by webhook-receiver */
interface WebhookMessage {
  provider:   string;
  rawBody:    string;
  receivedAt: string;
}

/** MercadoPago notification body shape */
interface MpNotification {
  type?:   string;
  action?: string;
  data?:   { id: string };
}

// ─── Handler ───────────────────────────────────────────────────────────────

/**
 * SQS-triggered Lambda — the authoritative payment state machine.
 *
 * All payment state transitions happen here.
 * batchSize=1 is configured in the construct — each record is one webhook notification.
 */
export const handler: SQSHandler = async (event) => {
  logger.info('webhook-processor: invoked', { messageCount: event.Records.length });

  for (const record of event.Records) {
    await processRecord(record);
  }
};

// ─── Per-record dispatcher ─────────────────────────────────────────────────

async function processRecord(record: SQSRecord): Promise<void> {
  try {
    const message    = JSON.parse(record.body) as WebhookMessage;
    const mpEvent    = JSON.parse(message.rawBody || '{}') as MpNotification;
    const eventType  = mpEvent.type;
    const dataId     = mpEvent.data?.id;

    logger.info('webhook-processor: processing', {
      messageId: record.messageId,
      eventType,
      dataId,
    });

    if (!eventType || !dataId) {
      logger.warn('webhook-processor: unrecognisable notification — skipping', {
        messageId: record.messageId, rawBody: message.rawBody,
      });
      return;
    }

    const token    = await getMercadoPagoAccessToken();
    const provider = providerFactory('mercadopago', token);

    if (eventType === 'payment') {
      await processPaymentNotification(provider, dataId);
    } else if (eventType === 'subscription_preapproval') {
      await processPreapprovalNotification(provider, dataId);
    } else {
      logger.info('webhook-processor: ignoring event type', { eventType });
    }
  } catch (error) {
    logger.error('webhook-processor: record processing failed', {
      messageId: record.messageId,
      error: error instanceof Error ? error.message : String(error),
    });
    // Re-throw → SQS retries up to maxReceiveCount (3), then DLQ
    throw error;
  }
}

// ─── Payment notification ──────────────────────────────────────────────────

async function processPaymentNotification(
  provider: ReturnType<typeof providerFactory>,
  providerPaymentId: string,
): Promise<void> {
  // 1. Fetch authoritative data from MP — never trust the webhook body alone
  const normalized = await provider.getPayment(providerPaymentId);

  // 2. Resolve local subscription — by providerSubscriptionId (preference_id) or userId from metadata
  let sub = normalized.providerSubscriptionId
    ? await getSubscriptionByProviderId(normalized.providerSubscriptionId)
    : null;

  if (!sub && normalized.userId) {
    logger.info('webhook-processor: preference_id not found, falling back to userId lookup', {
      providerPaymentId,
      userId: normalized.userId,
    });
    sub = await getSubscription(normalized.userId);
  }

  if (!sub) {
    logger.warn('webhook-processor: subscription not found for payment', {
      providerPaymentId,
      providerSubscriptionId: normalized.providerSubscriptionId,
      userId: normalized.userId,
    });
    return;
  }

  // 3. Idempotent payment upsert
  const now        = new Date().toISOString();
  const paymentId  = crypto.randomUUID();
  const paymentDate = now.substring(0, 10); // YYYY-MM-DD

  const payment: Payment = {
    PK:     sub.PK,
    SK:     `PAYMENT#${paymentDate}#${paymentId}`,
    entity: 'payment',
    paymentId,
    providerPaymentId: normalized.providerPaymentId,
    GSI2PK: `PROVIDER_PAY#${normalized.providerPaymentId}`,
    status:   normalized.status,
    amount:   normalized.amount,
    currency: normalized.currency,
    rawPayload: normalized.rawPayload,
    createdAt: now,
  };

  const wasWritten = await upsertPayment(payment);
  if (!wasWritten) {
    // Duplicate webhook delivery — already processed; no state to update
    logger.info('webhook-processor: duplicate payment — skipping', {
      providerPaymentId: normalized.providerPaymentId,
    });
    return;
  }

  // 4. Subscription status transitions
  if (normalized.status === 'SUCCESS') {
    // Activate: covers PENDING (first payment) and PAST_DUE (recovery payment)
    if (['PENDING', 'PAST_DUE', 'TRIAL'].includes(sub.status)) {
      const daysMap: Record<string, number> = { monthly: 30, yearly: 365 };
      const days      = daysMap[sub.billingCycle] ?? 30;
      const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
      const ttl       = Math.floor(Date.now() / 1000) + days * 24 * 60 * 60;
      await safeUpdateStatus(sub.userId, 'ACTIVE', sub.status, { expiresAt, ttl });
    }
  } else if (normalized.status === 'FAILED') {
    // Grace period: only move ACTIVE/TRIAL to PAST_DUE on payment failure
    if (['ACTIVE', 'TRIAL'].includes(sub.status)) {
      const graceMs     = (sub.gracePeriodDays ?? 7) * 24 * 60 * 60 * 1000;
      const graceEndsAt = new Date(Date.now() + graceMs).toISOString();
      await safeUpdateStatus(sub.userId, 'PAST_DUE', sub.status, { graceEndsAt });
    }
  }

  // 5. Audit event
  await writeEvent({
    PK:     `SUBSCRIPTION#${sub.subscriptionId}`,
    SK:     `EVENT#${now}#${paymentId}`,
    entity: 'event',
    type:   `PAYMENT_${normalized.status}`,
    payload: {
      paymentId,
      providerPaymentId: normalized.providerPaymentId,
      amount:   normalized.amount,
      currency: normalized.currency,
    },
    createdAt: now,
  });

  // 6. EventBridge (optional — enabled by construct prop)
  if (process.env.ENABLE_EVENT_BRIDGE === 'true') {
    await publishEvent('payment.processed', {
      userId:         sub.userId,
      subscriptionId: sub.subscriptionId,
      paymentId,
      status:   normalized.status,
      amount:   normalized.amount,
      currency: normalized.currency,
    });
  }
}

// ─── Preapproval notification ──────────────────────────────────────────────

async function processPreapprovalNotification(
  provider: ReturnType<typeof providerFactory>,
  providerSubscriptionId: string,
): Promise<void> {
  // 1. Fetch authoritative data
  const normalized = await provider.getPreapproval(providerSubscriptionId);

  // 2. Resolve local subscription
  const sub = await getSubscriptionByProviderId(providerSubscriptionId);
  if (!sub) {
    logger.warn('webhook-processor: subscription not found for preapproval', {
      providerSubscriptionId,
    });
    return;
  }

  // Map NormalizedSubscription status to our SubscriptionStatus
  // NormalizedSubscription.status: 'PENDING' | 'ACTIVE' | 'CANCELED' | 'PAST_DUE' | 'PAUSED'
  const newStatus = normalized.status === 'PAUSED' ? 'PAST_DUE' : normalized.status;

  if (newStatus === sub.status) {
    logger.info('webhook-processor: no status change required', { providerSubscriptionId });
    return;
  }

  const now         = new Date().toISOString();
  const extraAttrs: Partial<Subscription> = {};

  if (newStatus === 'CANCELED') {
    extraAttrs.canceledAt = now;
  } else if (newStatus === 'PAST_DUE') {
    const graceMs     = (sub.gracePeriodDays ?? 7) * 24 * 60 * 60 * 1000;
    extraAttrs.graceEndsAt = new Date(Date.now() + graceMs).toISOString();
  }

  const updated = await safeUpdateStatus(sub.userId, newStatus as Subscription['status'], sub.status, extraAttrs);
  if (!updated) return; // concurrent update already applied this change

  // 3. Audit event
  await writeEvent({
    PK:     `SUBSCRIPTION#${sub.subscriptionId}`,
    SK:     `EVENT#${now}#${crypto.randomUUID()}`,
    entity: 'event',
    type:   `SUBSCRIPTION_${newStatus}`,
    payload: {
      providerSubscriptionId,
      providerStatus: normalized.status,
      previousStatus: sub.status,
    },
    createdAt: now,
  });

  // 4. EventBridge
  if (process.env.ENABLE_EVENT_BRIDGE === 'true') {
    await publishEvent('subscription.status.changed', {
      userId:         sub.userId,
      subscriptionId: sub.subscriptionId,
      oldStatus:      sub.status,
      newStatus,
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Conditional status update that swallows concurrent-write conflicts.
 * Returns true if the update succeeded, false if skipped (already changed).
 */
async function safeUpdateStatus(
  userId: string,
  newStatus: Subscription['status'],
  expectedStatus: Subscription['status'],
  extraAttrs: Partial<Subscription>,
): Promise<boolean> {
  try {
    await updateSubscriptionStatus(userId, newStatus, expectedStatus, extraAttrs);
    logger.info('webhook-processor: status updated', { userId, newStatus });
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      logger.warn('webhook-processor: status already changed (concurrent update) — skipping', {
        userId, expectedStatus, newStatus,
      });
      return false;
    }
    throw err;
  }
}

/** Publish a single event to the default EventBridge bus */
async function publishEvent(
  detailType: string,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await ebClient.send(new PutEventsCommand({
      Entries: [{
        Source:     process.env.SERVICE_NAME ?? 'payments-module',
        DetailType: detailType,
        Detail:     JSON.stringify(detail),
        EventBusName: 'default',
      }],
    }));
  } catch (err) {
    // EventBridge publish failures must not fail the webhook processing
    logger.error('webhook-processor: EventBridge publish failed', {
      detailType,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
