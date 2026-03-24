# Payments Module — Architecture Review & Observations

**Module:** `vitas-doctors-payments`
**Reviewed:** 2026-03-24
**Reviewer:** Senior AWS/CDK Engineer
**Context:** Backend payments processing for `vitas-client` (Next.js 15 doctor portal) — healthcare platform (IPRESS) in Peru, MercadoPago integration, sa-east-1 region.

---

## Summary

The module is well-structured: single-table DynamoDB design, least-privilege IAM, idempotent writes with conditional expressions, provider abstraction via `IPaymentProvider`, and async webhook processing through SQS. The foundations are solid. The observations below target gaps that matter specifically for a **payments system in production** — data loss risks, bottlenecks, operational readiness, and integration with the existing Vitas ecosystem.

---

## P0 — Must Fix Before Production

### 1. FIFO Queue uses a single MessageGroupId (throughput bottleneck)

**File:** `cdk/lib/subscription-construct.ts`
**Problem:** In production, the SQS FIFO queue sets `MessageGroupId = "mercadopago-webhooks"` for every message. FIFO guarantees ordering **per group** — using one group means all webhooks across all doctors/subscriptions are serialized into a single processing lane. If Doctor A's webhook takes 60s (Lambda timeout), Doctor B's payment confirmation sits waiting.

**Impact:** At scale, this creates a sequential bottleneck. If one message fails and retries 3 times (maxReceiveCount), it blocks the entire queue for ~18 minutes (3 retries x 370s visibility timeout).

**Recommendation:** Use `providerSubscriptionId` or `userId` as the MessageGroupId. This preserves per-subscription ordering (important for payment→status transitions) while allowing different subscriptions to process concurrently.

```typescript
// webhook-receiver/handler.ts — current
MessageGroupId: 'mercadopago-webhooks'

// proposed
MessageGroupId: body.data?.id || body.id || 'unknown'
```

---

### 2. Webhook Receiver swallows SQS failures — payment data loss

**File:** `lambda/webhook-receiver/src/handler.ts`
**Problem:** If `sqs.send()` throws, the handler catches the error, logs it, and **returns HTTP 200** to MercadoPago. Since MercadoPago received a 200, it considers the webhook delivered and will not retry. The payment notification is permanently lost.

**Impact:** A transient SQS outage or throttle during a payment notification means the doctor's subscription never activates, with no automated recovery path.

**Recommendation:** Return HTTP 500 on SQS failure. MercadoPago retries with exponential backoff (up to 4 attempts). The function is idempotent downstream (conditional PutItem), so retries are safe.

```typescript
// current behavior (dangerous)
catch (err) {
  logger.error('Failed to enqueue', { err });
  return { statusCode: 200, body: 'OK' }; // <-- data loss
}

// proposed
catch (err) {
  logger.error('Failed to enqueue', { err });
  return { statusCode: 500, body: 'Internal error' }; // MP retries
}
```

---

### 3. Hardcoded 30-day expiry ignores billing cycle

**File:** `lambda/webhook-processor/src/handler.ts`
**Problem:** On successful payment, `expiresAt` is set to `Date.now() + 30 days` regardless of whether the subscription is monthly or yearly. A doctor on a yearly plan would lose access after 30 days despite paying for 12 months.

**Impact:** Direct revenue impact — yearly subscribers get treated as monthly.

**Recommendation:** Read `billingCycle` from the subscription record and compute expiry accordingly:

```typescript
const daysMap = { monthly: 30, yearly: 365 };
const days = daysMap[subscription.billingCycle] || 30;
const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
```

---

### 4. No CORS configuration — frontend cannot call these endpoints

**File:** `cdk/lib/subscription-construct.ts`
**Problem:** The API Gateway resources (`/subscriptions`, `/webhooks`) do not configure CORS headers. The `vitas-client` frontend (Next.js on Vercel) makes browser requests to these endpoints — browsers will block them without `Access-Control-Allow-Origin`.

**Impact:** All subscription endpoints are unreachable from the doctor portal unless CORS is handled at the BFF layer (Next.js API routes proxying). If direct browser calls are intended, this is a blocker.

**Recommendation:** If the frontend calls these directly, add CORS to the CDK construct:

```typescript
subscriptionsResource.addCorsPreflight({
  allowOrigins: isProd
    ? ['https://app.vitasclinic.com']
    : ['http://localhost:3000'],
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
});
```

If the `vitas-client` BFF proxies all calls (consistent with the existing pattern in `CLAUDE.md`: "Next.js API routes proxy to AWS API Gateway"), document this explicitly and ensure the BFF routes exist.

---

## P1 — Should Fix Before Production

### 5. No WAF or rate limiting on webhook endpoint

**File:** `cdk/lib/subscription-construct.ts`
**Problem:** `/webhooks/mercadopago` is a public, unauthenticated endpoint. Anyone who discovers the URL can flood the SQS queue with fake webhook payloads. While the webhook-processor validates via authoritative MP API lookup (good), each fake message still consumes: SQS throughput, Lambda invocations, Secrets Manager calls (to get the MP token), and MercadoPago API quota.

**Impact:** Cost amplification attack. A bad actor sending 10k fake webhooks/minute forces 10k Lambda invocations + 10k MP API calls.

**Recommendation:**
- **Quick win:** Add API Gateway resource policy or throttling (e.g., 100 requests/minute on the webhook path)
- **Better:** Attach a WAF WebACL with rate-based rules
- **Best:** Combine WAF rate limiting with IP allowlisting for MercadoPago's webhook source IPs

---

### 6. No X-Ray tracing across the distributed pipeline

**Problem:** The payment flow spans 5 services: API GW → Lambda → SQS → Lambda → MercadoPago API → DynamoDB → EventBridge. Without tracing, debugging a failed payment requires correlating logs across 3+ CloudWatch log groups manually.

**Impact:** Slow incident response. When a doctor reports "I paid but my subscription didn't activate," the team has no single trace to follow.

**Recommendation:** Enable active tracing on all Lambda functions in the CDK construct:

```typescript
tracing: lambda.Tracing.ACTIVE
```

Add X-Ray subsegments for outbound HTTP calls in `mercadopago-adapter.ts`. This gives end-to-end visibility from webhook receipt to subscription activation.

---

### 7. Enable EventBridge by default — vitas-client has no way to react to payment events

**File:** `cdk/lib/subscription-construct.ts`
**Problem:** `ENABLE_EVENT_BRIDGE` defaults to `false`. This means no other service in the Vitas ecosystem (vitas-client, vitas-chatbot-stack, vitas-main-stack) can react to payment lifecycle events. The doctor portal has no way to know when a subscription activates, fails, or cancels — except by polling DynamoDB.

**Impact:** The vitas-client frontend cannot show real-time subscription status updates. Email/WhatsApp notifications for payment success/failure cannot be triggered. The `ai_features` system (which gates intelligent consultations behind subscription status) cannot auto-update.

**Recommendation:** Enable EventBridge in all environments and publish a documented event catalog:

| Event | Source | Detail Type |
|-------|--------|-------------|
| `payment.processed` | `vitas-payments` | Payment success/failure with subscription context |
| `payment.created` | `vitas-payments` | New payment record created |
| `subscription.status.changed` | `vitas-payments` | Status transition (e.g., PENDING → ACTIVE) |

This allows `vitas-main-stack` to subscribe and update `ai_features` or `service_active` based on subscription status — closing the loop between payments and feature gating.

---

### 8. Prod deploy skips CDK approval — dangerous for a payments stack

**File:** `cdk/package.json`, `ops/build-and-deploy.sh`
**Problem:** Both `deploy:prod` script and `build-and-deploy.sh` use `--require-approval never`. This means CDK will apply IAM permission changes, security group modifications, or resource replacements without human review.

**Impact:** A CDK change that accidentally broadens Lambda permissions (e.g., granting `dynamodb:DeleteItem`) deploys silently to prod.

**Recommendation:**

```json
"deploy:prod": "ENVIRONMENT=prod npx cdk deploy --all --require-approval broadening"
```

Keep `--require-approval never` for dev only.

---

### 9. Prod account ID is a placeholder

**File:** `cdk/bin/app.ts`
**Problem:** The prod environment is configured with `account: 'PROD_ACCOUNT_ID'` — a literal placeholder string. CDK synth will succeed but produce a template targeting a nonexistent account.

**Recommendation:** Read from environment variable with validation:

```typescript
const prodAccount = process.env.PROD_ACCOUNT_ID;
if (stage === 'prod' && !prodAccount) {
  throw new Error('PROD_ACCOUNT_ID environment variable is required for prod deployment');
}
```

---

### 10. No tests — zero test coverage for a payments system

**Problem:** There are no test files anywhere in the repository. No unit tests, no integration tests, no CDK snapshot tests.

**Impact:** For a system that handles money, this is the highest-risk gap. The webhook-processor state machine alone has ~12 status transition paths — any regression silently breaks payment processing. CDK changes can drift infrastructure without snapshot tests catching it.

**Recommendation (phased):**

| Phase | Scope | What to Test |
|-------|-------|-------------|
| **1 (now)** | Unit tests | `feature-gate.ts` (access rules), `mercadopago-adapter.ts` (status mapping), `errors.ts` (HTTP response mapping) |
| **2 (before prod)** | Integration tests | `webhook-processor` state machine — all status transitions with mocked DynamoDB/MP API |
| **3 (before prod)** | CDK snapshot | `cdk synth` output snapshot to catch unintended infra changes |
| **4 (ongoing)** | E2E | Sandbox MercadoPago flow: create subscription → simulate payment → verify status transition |

Framework suggestion: `vitest` (aligns with the Vitas ecosystem, fast, TypeScript-native).

---

## P2 — Important Improvements

### 11. No retry/circuit-breaker for MercadoPago API calls

**File:** `lambda/shared/src/mercadopago-adapter.ts`
**Problem:** All outbound HTTP calls to MercadoPago use raw `fetch()` with no timeout, no retries, and no circuit breaking. If MP is slow (common in LATAM), the Lambda sits idle until the 30-60s timeout, consuming memory and cost.

**Recommendation:**
- Set per-request timeout: 5-8 seconds
- Add 2-3 retries with exponential backoff for 5xx/network errors
- Do **not** retry 4xx (invalid request, not found)

```typescript
// lightweight retry helper — no external deps needed
async function fetchWithRetry(url: string, opts: RequestInit, maxRetries = 3): Promise<Response> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      if (res.status < 500) return res;
    } catch (err) {
      if (attempt === maxRetries - 1) throw err;
    } finally {
      clearTimeout(timeout);
    }
    await new Promise(r => setTimeout(r, 2 ** attempt * 500));
  }
  throw new Error('Max retries exceeded');
}
```

---

### 12. API Gateway throttling not configured

**Problem:** The subscription endpoints have no usage plan or method-level throttling. A compromised JWT can hammer `POST /subscriptions` and create unlimited MercadoPago checkout sessions, potentially incurring costs on the MP side.

**Recommendation:** Add a usage plan in the CDK construct:

```typescript
const plan = api.addUsagePlan('PaymentsThrottle', {
  throttle: { rateLimit: 10, burstLimit: 20 }, // per second
});
```

For the webhook endpoint specifically, limit to ~100 req/min (MercadoPago's realistic throughput).

---

### 13. DLQ has no redrive strategy

**Problem:** The DLQ alarm fires when messages land in the dead-letter queue, but there is no automated or documented way to inspect and replay them. For a payments system, a message in the DLQ means a payment notification was not processed after 3 attempts.

**Recommendation:**
- Document a runbook: how to inspect DLQ messages, identify the failure, and replay
- Consider a DLQ redrive Lambda that can be triggered manually via console or CLI
- At minimum, the DLQ alarm notification should include the message body (or a link to the CloudWatch log group) so the on-call engineer has immediate context

---

### 14. Consider Lambda Powertools over custom logger

**File:** `lambda/shared/src/logger.ts`
**Problem:** The custom structured logger works but is minimal. It lacks: correlation IDs, automatic Lambda context injection, cold start detection, and sampling. These are table-stakes for production observability.

**Recommendation:** Adopt `@aws-lambda-powertools/logger` (and optionally `tracer`, `metrics`). This is a drop-in replacement that adds:
- Automatic `requestId`, `functionName`, `coldStart` in every log line
- Log sampling (reduce debug noise in prod)
- Correlation ID propagation across SQS → Lambda chains
- Native X-Ray integration

---

### 15. Shared module has no `package.json` — fragile bundling

**File:** `lambda/shared/`
**Problem:** The shared utilities directory has no `package.json` or independent build step. It relies entirely on esbuild resolving relative imports during CDK synth. This prevents: independent testing of shared code, local development outside the CDK build, and dependency version pinning.

**Recommendation:** Add a `package.json` to `lambda/shared/` with build and test scripts. Alternatively, promote shared code to a **Lambda Layer** to reduce individual function bundle sizes and cold start times across all 6 functions.

---

## P3 — Nice to Have / Future Considerations

### 16. Input validation with Zod

**Problem:** Request body parsing in Lambda handlers uses manual `if (!body.planId)` checks. The `vitas-client` frontend already uses Zod for all input validation — the payments module should follow the same pattern for consistency and type safety.

**Recommendation:** Add `zod` as a shared dependency and define schemas:

```typescript
const CreateSubscriptionSchema = z.object({
  planId: z.string().uuid(),
  billingCycle: z.enum(['monthly', 'yearly']),
});
```

---

### 17. Duplicated JWT auth implementations

**Files:** `lambda/shared/src/auth-context.ts` and `authorizer/src/handler.ts`
**Problem:** Two independent JWT verification implementations exist. The authorizer is marked "optional" and unused (Vitas validates JWT directly in Lambda), but its presence creates maintenance risk — a security patch to one could miss the other.

**Recommendation:** If the API Gateway TOKEN authorizer is not needed (vitas-client pattern confirms JWT is validated in-Lambda), remove the `authorizer/` directory entirely to avoid confusion. If it might be needed later, add a clear `DEPRECATED` notice.

---

### 18. CloudWatch alarms only cover errors — no latency or throttle monitoring

**Problem:** Metric filters only match `{ $.level = "error" }`. There are no alarms for:
- P99 Lambda duration spikes (early warning for MP API slowness)
- Lambda throttles (capacity planning)
- DynamoDB `ConditionalCheckFailedException` rates (race condition signal)
- API Gateway 4xx/5xx rates

**Recommendation:** Add at minimum:
- `webhook-processor` P99 duration alarm (threshold: 50s, since timeout is 60s)
- Lambda concurrent executions alarm per function
- API Gateway 5xx rate alarm on the `/subscriptions` resource

---

## Architecture Diagram (for reference)

```
                         vitas-client (Next.js / Vercel)
                                    │
                                    ▼
                          API Gateway (imported)
                          ┌─────────┴──────────┐
                          │                    │
                    [JWT in Lambda]        [Public]
                          │                    │
              ┌───────────┼──────────┐         │
              ▼           ▼          ▼         ▼
         create-sub   get-sub   cancel-sub  webhook-receiver
              │                     │          │
              │                     │          ▼
              │                     │      SQS Queue ──► DLQ
              │                     │          │            │
              ▼                     ▼          ▼            ▼
         MercadoPago API ◄──── webhook-processor      CloudWatch
              │                     │                   Alarm
              │                     ▼
              │               DynamoDB (SaasCore)
              │                     │
              │                DDB Stream
              │                     │
              │                     ▼
              │          subscription-events-processor
              │                     │
              └─────────────────────┼──────────────────────┐
                                    ▼                      ▼
                              EventBridge            CloudWatch
                                    │                  Alarms
                                    ▼
                         (vitas-main-stack / other consumers)
```

---

## Discussion Points for Team Alignment

1. **CORS vs BFF proxy** — Confirm whether `vitas-client` calls payment endpoints directly (needs CORS) or through BFF API routes (needs route implementation). The existing Vitas pattern uses BFF, so likely BFF routes are needed in `vitas-client`.

2. **EventBridge event schema** — Before enabling, agree on event schemas with the `vitas-main-stack` team. The `ai_features` auto-management system may need to subscribe to `subscription.status.changed` to toggle features based on payment status.

3. **Plan seeding strategy** — The `Plans_Table` has no API to create/manage plans. How will plans be seeded? Direct DynamoDB writes? A separate admin API? A seed script in `ops/`?

4. **Grace period policy** — `gracePeriodDays` is defined per-plan but the business rules for what happens during grace (full access? read-only? degraded?) should be confirmed with the product team. Currently `feature-gate.ts` grants full access during grace.

5. **Yearly billing with MercadoPago** — The current adapter uses Checkout Pro (one-time payment preferences). Yearly subscriptions with auto-renewal need MercadoPago's Subscriptions API (`/preapproval_plan`). Confirm the billing model before production launch.
