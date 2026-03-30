import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface SubscriptionModuleProps {
  /**
   * Deployment environment identifier (e.g. 'dev', 'staging', 'production').
   * Used as a suffix for all resource names to avoid collisions.
   */
  environment: string;

  /**
   * An existing API Gateway RestApi instance.
   * Subscription routes will be added as resources on this API.
   * Compatible with any RestApi — Vitas or any future SaaS project.
   */
  restApi: apigateway.RestApi;

  /**
   * Use SQS FIFO queue for webhook processing.
   * FIFO guarantees exactly-once delivery per providerPaymentId.
   * Recommended for production. Default: false (Standard queue).
   */
  useFifoQueue?: boolean;

  /**
   * Prefix for DynamoDB table names and resource names.
   * Default: 'payments'
   * Example: 'vitas' → 'vitas-Plans-dev', 'vitas-SaasCore-dev'
   */
  tableNamePrefix?: string;

  /**
   * Optional KMS key for DynamoDB encryption at rest.
   * If omitted, AWS-managed key is used.
   */
  encryptionKey?: kms.Key;

  /**
   * API Gateway authorizer to attach to subscription routes.
   * If omitted, routes will have no authorizer (not recommended for production).
   * Pass the authorizer from your existing stack.
   */
  authAuthorizer?: apigateway.IAuthorizer;

  /**
   * Emit subscription lifecycle events to Amazon EventBridge.
   * Useful for cross-service integrations (emails, analytics, etc.).
   * Default: false
   */
  enableEventBridge?: boolean;

  /**
   * SNS Topic ARN for CloudWatch alarm notifications.
   * If omitted, alarms are created but have no action.
   */
  alarmTopicArn?: string;

  /**
   * SSM Parameter Store path for the JWT secret used to validate Bearer tokens.
   * Default: '/vitas/auth/jwt-secret' — matches the Vitas stack convention.
   * Override when integrating with a different project that stores its JWT secret
   * at a different SSM path (e.g. '/clinicpro/auth/jwt-secret').
   */
  jwtSecretParam?: string;
}

// ─── Construct ────────────────────────────────────────────────────────────────

/**
 * SubscriptionModule — reusable CDK construct for subscriptions & payments.
 *
 * Deploys:
 *  - DynamoDB Plans_Table + SaasCore_Table (single-table, with streams & GSIs)
 *  - SQS WebhookQueue + DLQ (Standard or FIFO, parametrizable)
 *  - Lambda functions: create-subscription, get-subscription, cancel-subscription,
 *    webhook-receiver, webhook-processor, subscription-events-processor
 *  - API Gateway routes attached to the provided restApi
 *  - CloudWatch log groups + alarms
 *  - Secrets Manager secret for payment provider credentials
 *  - IAM least-privilege policies per Lambda
 *
 * Usage:
 *   new SubscriptionModule(stack, 'Subscriptions', { restApi, environment: 'dev' })
 */
export class SubscriptionModule extends Construct {
  /** The plans DynamoDB table (canonical plan definitions) */
  public readonly plansTable: dynamodb.Table;

  /** The SaasCore DynamoDB table (single-table for user-generated data) */
  public readonly saasCoreTable: dynamodb.Table;

  /** The webhook SQS queue */
  public readonly webhookQueue: sqs.Queue;

  /** Dead-letter queue for failed webhook messages */
  public readonly webhookDlq: sqs.Queue;

  /** MercadoPago credentials secret — update values via AWS Console before using */
  public readonly mpSecret: secretsmanager.Secret;

  /** Lambda: creates a subscription checkout session */
  public readonly createSubscriptionFn: lambdaNodejs.NodejsFunction;

  /** Lambda: returns the authenticated user's subscription */
  public readonly getSubscriptionFn: lambdaNodejs.NodejsFunction;

  /** Lambda: cancels a subscription */
  public readonly cancelSubscriptionFn: lambdaNodejs.NodejsFunction;

  /** Lambda: generic usage tracking — checks and increments any metered feature */
  public readonly trackUsageFn: lambdaNodejs.NodejsFunction;

  /** Lambda: receives MP webhooks and enqueues to SQS */
  public readonly webhookReceiverFn: lambdaNodejs.NodejsFunction;

  /** Lambda: processes webhook messages from SQS and updates subscription state */
  public readonly webhookProcessorFn: lambdaNodejs.NodejsFunction;

  /** Lambda: processes DynamoDB stream events for subscription lifecycle side-effects */
  public readonly subscriptionEventsProcessorFn: lambdaNodejs.NodejsFunction;

  /** CloudWatch alarm that fires when any message lands in the webhook DLQ */
  public readonly dlqDepthAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: SubscriptionModuleProps) {
    super(scope, id);

    // ── Derived config ─────────────────────────────────────────────────────
    const prefix = props.tableNamePrefix ?? 'payments';
    const env = props.environment;
    const useFifo = props.useFifoQueue ?? false;
    const enableEventBridge = props.enableEventBridge ?? false;

    // Non-dev environments retain data on stack deletion — never destroy payments data.
    const isProduction = env === 'production' || env === 'prod' || env === 'staging';
    const removalPolicy = isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    // Customer-managed KMS key when provided; otherwise AWS-managed (free).
    const tableEncryption = props.encryptionKey
      ? dynamodb.TableEncryption.CUSTOMER_MANAGED
      : dynamodb.TableEncryption.AWS_MANAGED;

    // ─────────────────────────────────────────────────────────────────────────
    // Stage 3a — Plans_Table
    // ─────────────────────────────────────────────────────────────────────────
    this.plansTable = new dynamodb.Table(this, 'PlansTable', {
      tableName: `${prefix}-Plans-${env}`,
      partitionKey: { name: 'planId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: tableEncryption,
      encryptionKey: props.encryptionKey,
      pointInTimeRecovery: true,
      removalPolicy,
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Stage 3b — SaasCore_Table (single-table design)
    //
    // Key schema:
    //   PK = USER#userId | SUBSCRIPTION#subscriptionId
    //   SK = SUBSCRIPTION#primary | PAYMENT#date#id | USAGE#feature#period | EVENT#ts
    //
    // GSI1 — PROVIDER_SUB#id → lookup subscription from provider webhook
    // GSI2 — PROVIDER_PAY#id → idempotency check for payment upserts
    // Stream — NEW_AND_OLD_IMAGES for subscription lifecycle side-effects
    // TTL — for future ephemeral items (idempotency keys, checkout sessions)
    // ─────────────────────────────────────────────────────────────────────────
    this.saasCoreTable = new dynamodb.Table(this, 'SaasCoreTable', {
      tableName: `${prefix}-SaasCore-${env}`,
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      timeToLiveAttribute: 'ttl',
      encryption: tableEncryption,
      encryptionKey: props.encryptionKey,
      pointInTimeRecovery: true,
      removalPolicy,
    });

    // GSI1 — full projection — webhook-processor needs the complete subscription item
    this.saasCoreTable.addGlobalSecondaryIndex({
      indexName: 'GSI1-ProviderSubscription',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI2 — minimal projection — only needs enough to check if payment was already processed
    this.saasCoreTable.addGlobalSecondaryIndex({
      indexName: 'GSI2-ProviderPayment',
      partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['paymentId', 'PK', 'status', 'createdAt'],
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Stage 4a — Secrets Manager
    //
    // Only access_token is required — it is the sole credential used for all
    // MercadoPago API calls (Preapproval create/cancel, payment lookup).
    //
    // Replace the placeholder BEFORE invoking any Lambda:
    //   aws secretsmanager put-secret-value \
    //     --secret-id /<prefix>/payments/mercadopago-<env> \
    //     --secret-string '{"access_token":"APP_USR-..."}'
    // ─────────────────────────────────────────────────────────────────────────
    this.mpSecret = new secretsmanager.Secret(this, 'MercadoPagoSecret', {
      secretName: `/${prefix}/payments/mercadopago-${env}`,
      description: `MercadoPago access_token for ${prefix} payments module (${env}). Update before first use.`,
      secretObjectValue: {
        access_token: cdk.SecretValue.unsafePlainText('REPLACE_ME'),
      },
      removalPolicy,
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Stage 4b — SQS Dead Letter Queue
    //
    // Always retained — contains failed webhook messages that must be investigated.
    // FIFO DLQ is required when the main queue is FIFO (AWS constraint).
    // Messages retained 14 days to allow manual replay/investigation.
    // ─────────────────────────────────────────────────────────────────────────
    this.webhookDlq = new sqs.Queue(this, 'WebhookDLQ', {
      queueName: useFifo
        ? `${prefix}-WebhookDLQ-${env}.fifo`
        : `${prefix}-WebhookDLQ-${env}`,
      fifo: useFifo,
      ...(useFifo && { contentBasedDeduplication: true }),
      retentionPeriod: cdk.Duration.days(14),
      // DLQ is ALWAYS retained — failed messages must be inspected before deletion
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Stage 4c — SQS Webhook Queue
    //
    // Buffers incoming webhooks from MercadoPago for async processing.
    // visibilityTimeout must be >= 6× webhook-processor Lambda timeout (60s → 370s).
    // DLQ maxReceiveCount=3: after 3 processing failures, message goes to DLQ.
    // ─────────────────────────────────────────────────────────────────────────
    this.webhookQueue = new sqs.Queue(this, 'WebhookQueue', {
      queueName: useFifo
        ? `${prefix}-WebhookQueue-${env}.fifo`
        : `${prefix}-WebhookQueue-${env}`,
      fifo: useFifo,
      ...(useFifo && { contentBasedDeduplication: true }),

      // Must be >= 6× Lambda timeout. webhook-processor timeout = 60s → 370s minimum.
      visibilityTimeout: cdk.Duration.seconds(370),

      deadLetterQueue: {
        queue: this.webhookDlq,
        maxReceiveCount: 3,
      },

      retentionPeriod: cdk.Duration.days(7),
      // Queue is retained — in-flight messages should not be lost on stack update
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Stage 4d — Common Lambda configuration
    //
    // All Lambdas share:
    //   - Node.js 20, ARM_64 (cost-efficient, consistent with Vitas stack)
    //   - 256MB memory (matching Vitas convention)
    //   - Structured JSON logging (LOG_LEVEL debug in dev, info in production)
    //   - @aws-sdk/* excluded from bundle (available in Lambda Node.js 20 runtime)
    //   - esbuild minification (reduces cold-start package size)
    //   - Log retention 7 days
    // ─────────────────────────────────────────────────────────────────────────
    const lambdaDir = (name: string) =>
      path.join(__dirname, `../../lambda/${name}`);

    const commonEnv: Record<string, string> = {
      ENVIRONMENT:      env,
      LOG_LEVEL:        isProduction ? 'info' : 'debug',
      SERVICE_NAME:     `${prefix}-payments`,
      CORE_TABLE_NAME:  this.saasCoreTable.tableName,
      PLANS_TABLE_NAME: this.plansTable.tableName,
    };

    // Shared env for Lambdas that validate the JWT directly (no API GW TOKEN authorizer).
    // Matches the vitas-main-stack pattern: each Lambda reads the secret from SSM at invocation time.
    const jwtSecretParam = props.jwtSecretParam ?? '/vitas/auth/jwt-secret';
    const authEnv: Record<string, string> = {
      JWT_SECRET_PARAM: jwtSecretParam,
    };

    const commonBundling: lambdaNodejs.BundlingOptions = {
      externalModules: ['@aws-sdk/*'],
      minify: true,
      sourceMap: false,
      target: 'node20',
    };

    const makeFn = (
      id: string,
      handlerDir: string,
      timeout: number,
      extraEnv: Record<string, string> = {},
    ): lambdaNodejs.NodejsFunction => {
      const fn = new lambdaNodejs.NodejsFunction(this, id, {
        entry:            path.join(lambdaDir(handlerDir), 'src/handler.ts'),
        depsLockFilePath: path.join(lambdaDir(handlerDir), 'package-lock.json'),
        runtime:      lambda.Runtime.NODEJS_20_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize:   256,
        timeout:      cdk.Duration.seconds(timeout),
        bundling:     commonBundling,
        environment:  { ...commonEnv, ...extraEnv },
        logRetention: logs.RetentionDays.ONE_WEEK,
        tracing:      lambda.Tracing.ACTIVE,
      });
      return fn;
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Stage 4e — Lambda functions
    // ─────────────────────────────────────────────────────────────────────────

    // POST /subscriptions — calls Plans_Table, MercadoPago, writes SaasCore
    // authEnv: JWT is validated inside the Lambda (no API GW TOKEN authorizer needed)
    this.createSubscriptionFn = makeFn('CreateSubscriptionFn', 'create-subscription', 30, {
      ...authEnv,
      MP_SECRET_ARN:      this.mpSecret.secretArn,
      WEBHOOK_QUEUE_URL:  this.webhookQueue.queueUrl,
    });

    // GET /subscriptions/me — reads SaasCore
    this.getSubscriptionFn = makeFn('GetSubscriptionFn', 'get-subscription', 10, {
      ...authEnv,
    });

    // POST /subscriptions/{id}/cancel — reads SaasCore, calls MercadoPago, updates SaasCore
    this.cancelSubscriptionFn = makeFn('CancelSubscriptionFn', 'cancel-subscription', 30, {
      ...authEnv,
      MP_SECRET_ARN: this.mpSecret.secretArn,
    });

    // POST /webhooks/mercadopago — enqueues to SQS, returns 200 immediately
    this.webhookReceiverFn = makeFn('WebhookReceiverFn', 'webhook-receiver', 10, {
      WEBHOOK_QUEUE_URL: this.webhookQueue.queueUrl,
    });

    // POST /subscriptions/me/usage/{feature} — generic usage check + increment per metered feature
    this.trackUsageFn = makeFn('TrackUsageFn', 'track-usage', 10, {
      ...authEnv,
    });

    // SQS-triggered — fetches from MP API, updates SaasCore, writes events
    // Timeout 60s: must be < visibilityTimeout/6 (370/6 ≈ 61s — keep at 60s)
    this.webhookProcessorFn = makeFn('WebhookProcessorFn', 'webhook-processor', 60, {
      MP_SECRET_ARN:        this.mpSecret.secretArn,
      ENABLE_EVENT_BRIDGE:  String(enableEventBridge),
    });

    // DynamoDB Stream-triggered — subscription lifecycle side-effects
    this.subscriptionEventsProcessorFn = makeFn(
      'SubscriptionEventsProcessorFn',
      'subscription-events-processor',
      30,
      {
        ENABLE_EVENT_BRIDGE: String(enableEventBridge),
      },
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Stage 4f — Event sources
    // ─────────────────────────────────────────────────────────────────────────

    // SQS → webhook-processor
    // batchSize=1: process one webhook at a time for maximum safety on payments.
    // bisectBatchOnError: not needed with batchSize=1.
    this.webhookProcessorFn.addEventSource(
      new lambdaEventSources.SqsEventSource(this.webhookQueue, {
        batchSize: 1,
        // reportBatchItemFailures: partial batch response — useful if batchSize > 1 in future
        reportBatchItemFailures: true,
      }),
    );

    // DynamoDB Stream → subscription-events-processor
    // TRIM_HORIZON: process from oldest available record on first deploy.
    // bisectBatchOnError: on partial failure, retry only the failing half.
    // filters: only invoke Lambda for subscription and payment entity changes.
    this.subscriptionEventsProcessorFn.addEventSource(
      new lambdaEventSources.DynamoEventSource(this.saasCoreTable, {
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 10,
        bisectBatchOnError: true,
        retryAttempts: 3,
        filters: [
          // Only process subscription and payment entity changes
          lambda.FilterCriteria.filter({
            dynamodb: {
              NewImage: {
                entity: { S: lambda.FilterRule.or('subscription', 'payment') },
              },
            },
          }),
        ],
      }),
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Stage 4g — IAM least-privilege grants
    //
    // Principle: each Lambda gets only the DynamoDB actions it actually performs.
    // DeleteItem is explicitly NOT granted to any Lambda — payments data is immutable.
    // BatchWriteItem is NOT granted — we use conditional PutItem/UpdateItem only.
    // ─────────────────────────────────────────────────────────────────────────

    // ── SSM read for JWT validation (create / get / cancel — they call resolveAuthContext) ──
    // Mirrors the vitas-main-stack pattern: each Lambda reads /vitas/auth/jwt-secret at runtime.
    const jwtSsmArn = `arn:aws:ssm:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:parameter${jwtSecretParam}`;
    const ssmJwtPolicy = new iam.PolicyStatement({
      actions:   ['ssm:GetParameter'],
      resources: [jwtSsmArn],
    });
    const kmsDecryptPolicy = new iam.PolicyStatement({
      actions:   ['kms:Decrypt'],
      resources: [`arn:aws:kms:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:key/*`],
      conditions: { StringEquals: { 'kms:ViaService': `ssm.${cdk.Stack.of(this).region}.amazonaws.com` } },
    });

    for (const fn of [this.createSubscriptionFn, this.getSubscriptionFn, this.cancelSubscriptionFn, this.trackUsageFn]) {
      fn.addToRolePolicy(ssmJwtPolicy);
      fn.addToRolePolicy(kmsDecryptPolicy);
    }

    // ── create-subscription ──────────────────────────────────────────────────
    // Reads plan → writes PENDING subscription item (with condition attribute_not_exists)
    this.plansTable.grant(this.createSubscriptionFn, 'dynamodb:GetItem');
    this.saasCoreTable.grant(this.createSubscriptionFn, 'dynamodb:GetItem', 'dynamodb:PutItem');
    this.mpSecret.grantRead(this.createSubscriptionFn);

    // ── get-subscription ─────────────────────────────────────────────────────
    // Read-only: returns USER#userId / SUBSCRIPTION#primary item
    this.saasCoreTable.grant(this.getSubscriptionFn, 'dynamodb:GetItem');

    // ── track-usage ───────────────────────────────────────────────────────────
    // Reads subscription + usage item, writes usage item (atomic ADD)
    this.saasCoreTable.grant(
      this.trackUsageFn,
      'dynamodb:GetItem',
      'dynamodb:UpdateItem',
    );

    // ── cancel-subscription ──────────────────────────────────────────────────
    // Reads subscription, calls MP cancel API, updates status, writes event
    this.saasCoreTable.grant(
      this.cancelSubscriptionFn,
      'dynamodb:GetItem',
      'dynamodb:UpdateItem',
      'dynamodb:PutItem',  // writes EVENT item
    );
    this.mpSecret.grantRead(this.cancelSubscriptionFn);

    // ── webhook-receiver ─────────────────────────────────────────────────────
    // Only sends to SQS — touches no DynamoDB or secrets
    this.webhookQueue.grantSendMessages(this.webhookReceiverFn);

    // ── webhook-processor ────────────────────────────────────────────────────
    // Reads GSIs (Query), upserts payments (PutItem), updates subscription (UpdateItem),
    // writes events (PutItem), reads plans for gracePeriodDays (GetItem)
    this.saasCoreTable.grant(
      this.webhookProcessorFn,
      'dynamodb:GetItem',
      'dynamodb:PutItem',    // idempotent payment upsert (condition: attribute_not_exists)
      'dynamodb:UpdateItem', // subscription status transition (condition on current status)
      'dynamodb:Query',      // GSI1 and GSI2 lookups
    );
    // GSI queries require permission on the index resource ARN in addition to the table
    this.webhookProcessorFn.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['dynamodb:Query'],
      resources: [
        `${this.saasCoreTable.tableArn}/index/GSI1-ProviderSubscription`,
        `${this.saasCoreTable.tableArn}/index/GSI2-ProviderPayment`,
      ],
    }));
    this.plansTable.grant(this.webhookProcessorFn, 'dynamodb:GetItem');
    this.mpSecret.grantRead(this.webhookProcessorFn);
    // SQS receive/delete permissions are added automatically by addEventSource above

    // ── subscription-events-processor ────────────────────────────────────────
    // Reads subscription for cache rehydration, may update limitsCached
    this.saasCoreTable.grant(
      this.subscriptionEventsProcessorFn,
      'dynamodb:GetItem',
      'dynamodb:UpdateItem',
    );
    // DynamoDB Stream read permission is added automatically by addEventSource above

    // ── Optional: EventBridge PutEvents ─────────────────────────────────────
    if (enableEventBridge) {
      const eventBridgePolicy = new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['events:PutEvents'],
        resources: [`arn:aws:events:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:event-bus/default`],
      });
      this.webhookProcessorFn.addToRolePolicy(eventBridgePolicy);
      this.subscriptionEventsProcessorFn.addToRolePolicy(eventBridgePolicy);
    }

    // ── Optional: KMS decrypt for customer-managed encryption key ───────────
    // CDK's table.grant() does not automatically add KMS permissions when using
    // addToRolePolicy directly. We add them explicitly here.
    if (props.encryptionKey) {
      const lambdasThatAccessTables = [
        this.createSubscriptionFn,
        this.getSubscriptionFn,
        this.cancelSubscriptionFn,
        this.trackUsageFn,
        this.webhookProcessorFn,
        this.subscriptionEventsProcessorFn,
      ];
      for (const fn of lambdasThatAccessTables) {
        props.encryptionKey.grant(fn, 'kms:Decrypt', 'kms:GenerateDataKey');
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Stage 5 — API Gateway Integration
    //
    // Routes added to props.restApi (any existing RestApi — Vitas or future apps):
    //
    //   POST   /subscriptions              → create-subscription  [authorized]
    //   GET    /subscriptions/me           → get-subscription     [authorized]
    //   POST   /subscriptions/{id}/cancel  → cancel-subscription  [authorized]
    //   POST   /webhooks/mercadopago       → webhook-receiver     [NO auth — public]
    //
    // Security model:
    //   - All subscription routes require the caller to be authenticated.
    //     The authAuthorizer prop injects userId via requestContext.authorizer.userId.
    //   - The webhook route is intentionally public — MercadoPago calls it without
    //     any auth token. Security is enforced downstream: webhook-receiver only
    //     enqueues the raw payload; webhook-processor always re-fetches authoritative
    //     data from the MP API before trusting anything.
    //
    // API Gateway response models:
    //   - 200/201 for success
    //   - 400 for validation errors
    //   - 401 for unauthorized (enforced by authorizer)
    //   - 4xx/5xx mapped from Lambda response body
    // ─────────────────────────────────────────────────────────────────────────

    // ── Lambda integrations ───────────────────────────────────────────────────
    const createSubIntegration   = new apigateway.LambdaIntegration(this.createSubscriptionFn,   { proxy: true });
    const getSubIntegration      = new apigateway.LambdaIntegration(this.getSubscriptionFn,      { proxy: true });
    const cancelSubIntegration   = new apigateway.LambdaIntegration(this.cancelSubscriptionFn,   { proxy: true });
    const webhookMpIntegration   = new apigateway.LambdaIntegration(this.webhookReceiverFn,      { proxy: true });

    // ── Method options for subscription routes ────────────────────────────────
    // No API Gateway TOKEN authorizer — JWT validation is handled inside each Lambda,
    // matching the vitas-main-stack pattern. The authAuthorizer prop is kept for
    // projects that prefer authorizer-based auth, but Vitas does not use it.
    const authorizedMethodOptions: apigateway.MethodOptions = props.authAuthorizer
      ? {
          authorizer: props.authAuthorizer,
          authorizationType: apigateway.AuthorizationType.CUSTOM,
        }
      : { authorizationType: apigateway.AuthorizationType.NONE };

    // ── /subscriptions ────────────────────────────────────────────────────────
    // Resource is added to the root of the provided restApi.
    // Multiple SubscriptionModule instances (different prefixes/envs) on the same
    // restApi would need distinct base paths — the caller is responsible for that.
    const subscriptionsResource = props.restApi.root.addResource('subscriptions');

    // POST /subscriptions → create-subscription
    subscriptionsResource.addMethod('POST', createSubIntegration, {
      ...authorizedMethodOptions,
      requestModels: {
        'application/json': apigateway.Model.EMPTY_MODEL,
      },
    });

    // GET /subscriptions/me → get-subscription
    // Uses a fixed 'me' path so the Lambda resolves userId from auth context,
    // never from the URL (prevents IDOR attacks — users can't query other users).
    const meResource = subscriptionsResource.addResource('me');
    meResource.addMethod('GET', getSubIntegration, authorizedMethodOptions);

    // POST /subscriptions/me/usage/{feature} → track-usage
    // Generic metered usage endpoint. Any project calls this from its own BFF proxy
    // before consuming a feature (e.g. chatbot_messages, ai_generations).
    // The {feature} key must match a key in plan.limits.
    const trackUsageIntegration = new apigateway.LambdaIntegration(this.trackUsageFn, { proxy: true });
    const usageResource = meResource.addResource('usage');
    usageResource.addResource('{feature}').addMethod('POST', trackUsageIntegration, authorizedMethodOptions);

    // POST /subscriptions/{id}/cancel → cancel-subscription
    // {id} is the subscriptionId. The Lambda validates it belongs to the caller.
    const subscriptionByIdResource = subscriptionsResource.addResource('{id}');
    const cancelResource = subscriptionByIdResource.addResource('cancel');
    cancelResource.addMethod('POST', cancelSubIntegration, authorizedMethodOptions);

    // ── /webhooks ─────────────────────────────────────────────────────────────
    const webhooksResource = props.restApi.root.addResource('webhooks');

    // POST /webhooks/mercadopago → webhook-receiver (NO authorizer — public)
    // MercadoPago sends webhooks from its own servers without our auth tokens.
    const mpWebhookResource = webhooksResource.addResource('mercadopago');
    mpWebhookResource.addMethod('POST', webhookMpIntegration, {
      // Explicitly no authorizer — this is intentional and documented
      authorizationType: apigateway.AuthorizationType.NONE,
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Stage 9 — CloudWatch Observability
    //
    // Per-Lambda error alarms:
    //   - MetricFilter on structured JSON logs: { $.level = "error" }
    //   - Alarm fires when error count >= 1 in a 5-minute window
    //
    // SQS DLQ alarm:
    //   - Fires when any message lands in the DLQ (maxReceiveCount exceeded)
    //   - This means a webhook was permanently unprocessable — needs investigation
    //
    // All alarms notify the alarmTopicArn SNS topic when provided.
    // ─────────────────────────────────────────────────────────────────────────

    // ── Optional SNS topic for alarm notifications ────────────────────────
    const alarmTopic = props.alarmTopicArn
      ? sns.Topic.fromTopicArn(this, 'AlarmTopic', props.alarmTopicArn)
      : undefined;

    // ── Per-Lambda error metric filters + alarms ──────────────────────────
    // Our structured logger emits JSON with a "level" field.
    // FilterPattern: { $.level = "error" } matches all logger.error() calls.
    const lambdasToMonitor: Array<{ fn: lambdaNodejs.NodejsFunction; name: string }> = [
      { fn: this.createSubscriptionFn,          name: 'CreateSubscription' },
      { fn: this.getSubscriptionFn,             name: 'GetSubscription' },
      { fn: this.cancelSubscriptionFn,          name: 'CancelSubscription' },
      { fn: this.trackUsageFn,                  name: 'TrackUsage' },
      { fn: this.webhookReceiverFn,             name: 'WebhookReceiver' },
      { fn: this.webhookProcessorFn,            name: 'WebhookProcessor' },
      { fn: this.subscriptionEventsProcessorFn, name: 'SubscriptionEventsProcessor' },
    ];

    for (const { fn, name } of lambdasToMonitor) {
      // MetricFilter: increment counter each time the Lambda logs an error
      const metricFilter = new logs.MetricFilter(this, `${name}ErrorMetricFilter`, {
        logGroup:        fn.logGroup,
        metricNamespace: `${prefix}/Payments`,
        metricName:      `${name}Errors`,
        filterPattern:   logs.FilterPattern.stringValue('$.level', '=', 'error'),
        metricValue:     '1',
        defaultValue:    0,
      });

      // Alarm: >= 1 error in any 5-minute window
      const alarm = new cloudwatch.Alarm(this, `${name}ErrorAlarm`, {
        alarmName:       `${prefix}-${name}-errors-${env}`,
        alarmDescription: `[${env}] ${name} Lambda logged errors — investigate CloudWatch Logs`,
        metric: metricFilter.metric({
          statistic: 'Sum',
          period:    cdk.Duration.minutes(5),
        }),
        threshold:           1,
        evaluationPeriods:   1,
        comparisonOperator:  cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData:    cloudwatch.TreatMissingData.NOT_BREACHING,
      });

      if (alarmTopic) {
        alarm.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));
        alarm.addOkAction(new cloudwatchActions.SnsAction(alarmTopic));
      }
    }

    // ── SQS DLQ depth alarm ───────────────────────────────────────────────
    // Any message in the DLQ = a webhook failed all 3 processing attempts.
    // Payments must never silently fail — this alarm is critical.
    const dlqAlarm = new cloudwatch.Alarm(this, 'WebhookDlqDepthAlarm', {
      alarmName:        `${prefix}-webhook-dlq-depth-${env}`,
      alarmDescription: `[${env}] Webhook DLQ has messages — a payment webhook permanently failed processing`,
      metric: this.webhookDlq.metricApproximateNumberOfMessagesVisible({
        period:    cdk.Duration.minutes(1),
        statistic: 'Maximum',
      }),
      threshold:          1,
      evaluationPeriods:  1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData:   cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    if (alarmTopic) {
      dlqAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alarmTopic));
      dlqAlarm.addOkAction(new cloudwatchActions.SnsAction(alarmTopic));
    }

    // ── Expose public references for dashboards / stack outputs ───────────
    // Callers can access these to add custom dashboard widgets or extra actions.
    this.dlqDepthAlarm = dlqAlarm;
  }
}
