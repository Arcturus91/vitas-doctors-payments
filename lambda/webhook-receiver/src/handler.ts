import type { APIGatewayProxyHandler } from 'aws-lambda';
import {
  SQSClient,
  SendMessageCommand,
  type SendMessageCommandInput,
} from '@aws-sdk/client-sqs';
import { logger } from '../../shared/src/logger';

const sqs = new SQSClient({});

/**
 * POST /webhooks/mercadopago
 *
 * Minimal, fast receiver. Must return 200 quickly to avoid MP retries.
 *
 * Responsibilities:
 *   - Accept the raw webhook payload
 *   - Enqueue the message to SQS for async processing by webhook-processor
 *   - Return 500 on SQS failure so MercadoPago retries the notification
 *
 * Security: MercadoPago does not provide a verifiable signature.
 *   Trust is enforced downstream in webhook-processor, which always re-fetches
 *   authoritative data from the MP API before writing any state.
 */
export const handler: APIGatewayProxyHandler = async (event) => {
  const receivedAt = new Date().toISOString();

  try {
    logger.info('webhook-receiver: message received', {
      provider:      'mercadopago',
      contentLength: event.body?.length ?? 0,
      receivedAt,
    });

    const queueUrl = process.env.WEBHOOK_QUEUE_URL;
    if (!queueUrl) {
      logger.error('webhook-receiver: WEBHOOK_QUEUE_URL not configured');
      return { statusCode: 500, body: JSON.stringify({ error: 'Queue not configured' }) };
    }

    // FIFO queues (URL ends with .fifo) require MessageGroupId.
    // Use the payment/resource ID from the notification so different subscriptions
    // process concurrently while preserving per-subscription ordering.
    const isFifo = queueUrl.endsWith('.fifo');

    let messageGroupId = 'unknown';
    if (isFifo) {
      try {
        const parsed = JSON.parse(event.body ?? '{}') as { data?: { id: string }; id?: string };
        messageGroupId = String(parsed.data?.id || parsed.id || 'unknown');
      } catch {
        // keep 'unknown' — still better than a single shared group
      }
    }

    const messageBody = JSON.stringify({
      provider:   'mercadopago',
      rawBody:    event.body ?? '',
      receivedAt,
    });

    const sendInput: SendMessageCommandInput = {
      QueueUrl:    queueUrl,
      MessageBody: messageBody,
      ...(isFifo && {
        MessageGroupId: messageGroupId,
        // Content-based deduplication is enabled on the FIFO queue; no need for explicit ID
      }),
    };

    await sqs.send(new SendMessageCommand(sendInput));

    logger.info('webhook-receiver: enqueued to SQS', { queueUrl, isFifo, messageGroupId });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ received: true }),
    };
  } catch (error) {
    // Return 500 so MercadoPago retries the notification. The processor is idempotent.
    logger.error('webhook-receiver: failed to enqueue', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal error' }),
    };
  }
};
