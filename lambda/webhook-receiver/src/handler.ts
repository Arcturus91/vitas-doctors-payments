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
 *   - Return 200 immediately — even if SQS fails (log only, no propagation)
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
      // Still return 200 — misconfiguration should not cause MP to retry forever
      return { statusCode: 200, body: JSON.stringify({ received: true }) };
    }

    // FIFO queues (URL ends with .fifo) require MessageGroupId
    const isFifo = queueUrl.endsWith('.fifo');

    const messageBody = JSON.stringify({
      provider:   'mercadopago',
      rawBody:    event.body ?? '',
      receivedAt,
    });

    const sendInput: SendMessageCommandInput = {
      QueueUrl:    queueUrl,
      MessageBody: messageBody,
      ...(isFifo && {
        // All MP webhooks share a group — preserves per-subscription ordering
        MessageGroupId: 'mercadopago-webhooks',
        // Content-based deduplication is enabled on the FIFO queue; no need for explicit ID
      }),
    };

    await sqs.send(new SendMessageCommand(sendInput));

    logger.info('webhook-receiver: enqueued to SQS', { queueUrl, isFifo });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ received: true }),
    };
  } catch (error) {
    // Always return 200 — do NOT let MP retry indefinitely due to our infrastructure issues
    logger.error('webhook-receiver: failed to enqueue (returning 200 to prevent MP retries)', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ received: true }),
    };
  }
};
