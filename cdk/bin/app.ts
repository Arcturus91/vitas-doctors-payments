#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { SubscriptionModule } from '../lib/subscription-construct';

// ─── Environment config ────────────────────────────────────────────────────────
// Matches vitas-main-stack convention: -c stage=dev | prod
const app   = new cdk.App();
const stage = (app.node.tryGetContext('stage') as string | undefined) ?? 'dev';

const prodAccount = process.env.PROD_ACCOUNT_ID;
if (stage === 'prod' && !prodAccount) {
  throw new Error('PROD_ACCOUNT_ID environment variable is required for prod deployment');
}

const envConfig: Record<string, { account: string; region: string }> = {
  dev:  { account: '197517026286',              region: 'sa-east-1' },
  prod: { account: prodAccount ?? 'UNRESOLVED', region: 'sa-east-1' },
};

if (!envConfig[stage]) {
  throw new Error(`Unknown stage: "${stage}". Use: npx cdk deploy -c stage=dev`);
}

// ─── VitasPaymentsStack ────────────────────────────────────────────────────────
//
// Standalone CDK stack that wires the payments module into the existing
// Vitas API Gateway. Deployed independently from vitas-main-stack.
//
// ──────────────────────────────────────────────────────────────────────────────
// Auth strategy: matches vitas-main-stack — NO API Gateway TOKEN authorizer.
// Each Lambda validates the JWT directly from the Authorization header,
// reading the secret from SSM /vitas/auth/jwt-secret at invocation time.
// This eliminates the separate authorizer Lambda that caused 403 errors.
//
// ──────────────────────────────────────────────────────────────────────────────
// DEPLOY ORDER:
//   1. Update the MercadoPago secret (printed as stack output after first deploy):
//        aws secretsmanager put-secret-value \
//          --secret-id /vitas/payments/mercadopago-dev \
//          --secret-string '{"access_token":"TEST-..."}'
//   2. Insert a test plan in vitas-Plans-dev (see README for the aws dynamodb put-item command)
//   3. Deploy:
//        cd ../vitas-payments-module && ./ops/build-and-deploy.sh
//
// ──────────────────────────────────────────────────────────────────────────────

class VitasPaymentsStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, stackStage: string) {
    super(scope, id, { env: envConfig[stackStage] });

    cdk.Tags.of(this).add('client', 'vitas-clinic');
    cdk.Tags.of(this).add('environment', stackStage);
    cdk.Tags.of(this).add('module', 'payments');

    const isProd = stackStage === 'prod';

    // ── 1. Import the existing API Gateway ───────────────────────────────
    // Pass the IDs via CDK context so this stack works for any project:
    //   npx cdk deploy -c stage=dev -c restApiId=wxpv27y874 -c rootResourceId=04x605ox35
    //
    // Vitas defaults are set here as fallback so you don't need to type them every time.
    const restApiId      = (app.node.tryGetContext('restApiId')      as string | undefined) ?? 'wxpv27y874';
    const rootResourceId = (app.node.tryGetContext('rootResourceId') as string | undefined) ?? '04x605ox35';

    const restApi = apigateway.RestApi.fromRestApiAttributes(this, 'VitasApi', {
      restApiId,
      rootResourceId,
    });

    // ── 2. SubscriptionModule ─────────────────────────────────────────────
    // No authAuthorizer prop — JWT validation happens inside each Lambda,
    // same as vitas-main-stack. The SSM read permission is granted automatically
    // by the construct for create/get/cancel Lambdas.
    const payments = new SubscriptionModule(this, 'Subscriptions', {
      restApi: restApi as apigateway.RestApi,

      environment:      stackStage,
      tableNamePrefix:  'vitas',
      useFifoQueue:     isProd,
      // Always emit EventBridge events — vitas-main-stack subscribes to apply its own side-effects
      enableEventBridge: true,
      // Sandbox test user — MP requires both collector and payer to be test users in dev
      ...(!isProd ? { defaultPayerEmail: 'test_user_3491999667425078735@testuser.com' } : {}),

      // Optional: set this to an existing SNS topic ARN to receive alarm notifications
      // alarmTopicArn: `arn:aws:sns:sa-east-1:${this.account}:vitas-ops-alerts`,
    });

    // ── 3. Stack outputs ──────────────────────────────────────────────────

    new cdk.CfnOutput(this, 'MercadoPagoSecretName', {
      value: payments.mpSecret.secretName,
      description:
        'Run before first deploy: ' +
        'aws secretsmanager put-secret-value --secret-id <name> ' +
        '--secret-string \'{"access_token":"TEST-..."}\'',
      exportName: `vitas-payments-MpSecretName-${stackStage}`,
    });

    new cdk.CfnOutput(this, 'WebhookUrl', {
      value: cdk.Fn.join('', [
        'https://',
        restApi.restApiId,
        '.execute-api.',
        this.region,
        '.amazonaws.com/prod/webhooks/mercadopago',
      ]),
      description:  'Set as notification_url in MercadoPago dashboard',
      exportName:   `vitas-payments-WebhookUrl-${stackStage}`,
    });

    new cdk.CfnOutput(this, 'DlqDepthAlarmName', {
      value:       payments.dlqDepthAlarm.alarmName,
      description: 'CloudWatch alarm that fires when a webhook permanently fails processing',
      exportName:  `vitas-payments-DlqAlarm-${stackStage}`,
    });
  }
}

// ─── Instantiate the stack ────────────────────────────────────────────────────
new VitasPaymentsStack(app, `VitasPayments-${stage}`, stage);

app.synth();
