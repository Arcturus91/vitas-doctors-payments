// ─── Domain Enums ─────────────────────────────────────────────────────────────

export type SubscriptionStatus =
  | 'PENDING'              // checkout created, awaiting first payment
  | 'TRIAL'                // within trial period (no payment required yet)
  | 'ACTIVE'               // paid and active
  | 'PAST_DUE'             // payment failed, within grace period
  | 'PENDING_CANCEL'       // cancellation requested, access until period ends
  | 'CANCELED'             // fully canceled
  | 'DOWNGRADED_TO_MANUAL'; // trial/grace expired — AI disabled, manual mode only

export type BillingCycle = 'monthly' | 'yearly';

export type PaymentStatus = 'PENDING' | 'SUCCESS' | 'FAILED' | 'REFUNDED';

export type PaymentProviderName = 'mercadopago' | 'stripe' | 'paypal';

// ─── DynamoDB Item Shapes ─────────────────────────────────────────────────────

/**
 * Plans_Table item. PK = planId.
 * Written by admins, read by Lambda on subscription creation.
 * Limits are cached into subscription item on creation to avoid cross-table reads.
 */
export interface Plan {
  planId: string;
  name: string;
  description?: string;
  price: number;
  currency: string;
  billingCycle: BillingCycle;
  limits: Record<string, number>; // e.g. { ai_generations: 100, appointments: 50 }
  gracePeriodDays: number;        // days of access after payment failure
  trialDays: number;              // days of free trial before first charge
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * SaasCore_Table — SUBSCRIPTION entity.
 * PK = USER#userId, SK = SUBSCRIPTION#primary
 *
 * GSI1: PROVIDER_SUB#providerSubscriptionId → lookup from provider webhook
 */
export interface Subscription {
  PK: string;                           // USER#userId
  SK: 'SUBSCRIPTION#primary';
  entity: 'subscription';
  subscriptionId: string;
  userId: string;
  tenantId?: string;                    // optional — for multi-tenant SaaS (e.g. Vitas clinic)
  /** Platform-specific doctor/user record ID — used to update ai_features on activation */
  doctorId?: string;
  planId: string;
  status: SubscriptionStatus;
  billingCycle: BillingCycle;
  provider: PaymentProviderName;
  providerSubscriptionId: string;
  GSI1PK: string;                       // PROVIDER_SUB#providerSubscriptionId
  GSI1SK: string;                       // USER#userId
  limitsCached: Record<string, number>; // copy of plan.limits — avoids cross-table reads
  gracePeriodDays: number;              // copy of plan.gracePeriodDays — avoids cross-table reads
  trialEndsAt?: string;                 // ISO 8601
  graceEndsAt?: string;                 // ISO 8601 — set on payment failure
  canceledAt?: string;                  // ISO 8601
  expiresAt?: string;                   // ISO 8601 — set on payment success (one-time billing)
  ttl?: number;                         // Unix epoch seconds — DynamoDB TTL attribute
  createdAt: string;
  updatedAt: string;
}

/**
 * SaasCore_Table — PAYMENT entity.
 * PK = USER#userId, SK = PAYMENT#yyyy-mm-dd#paymentId
 *
 * GSI2: PROVIDER_PAY#providerPaymentId → lookup from provider webhook
 */
export interface Payment {
  PK: string;  // USER#userId
  SK: string;  // PAYMENT#yyyy-mm-dd#paymentId
  entity: 'payment';
  paymentId: string;
  providerPaymentId: string;
  GSI2PK: string; // PROVIDER_PAY#providerPaymentId
  status: PaymentStatus;
  amount: number;
  currency: string;
  rawPayload: Record<string, unknown>; // full provider response for audit
  createdAt: string;
}

/**
 * SaasCore_Table — USAGE entity.
 * PK = USER#userId, SK = USAGE#feature#YYYY-MM
 *
 * Updated via atomic ADD — never overwritten directly.
 */
export interface UsageItem {
  PK: string; // USER#userId
  SK: string; // USAGE#feature#YYYY-MM
  entity: 'usage';
  count: number;
}

/**
 * SaasCore_Table — EVENT entity.
 * PK = SUBSCRIPTION#subscriptionId, SK = EVENT#<ISO timestamp>
 *
 * Immutable audit log of subscription lifecycle changes.
 */
export interface SubscriptionEvent {
  PK: string;  // SUBSCRIPTION#subscriptionId
  SK: string;  // EVENT#<ISO timestamp>
  entity: 'event';
  type: string; // e.g. 'SUBSCRIPTION_ACTIVATED', 'PAYMENT_FAILED', 'TRIAL_STARTED'
  payload: Record<string, unknown>;
  createdAt: string;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Resolved from API Gateway authorizer context.
 * The authorizer (external to this module) must inject userId.
 */
export interface AuthContext {
  userId: string;
  /** Platform-specific doctor/user identifier — extracted from JWT when present */
  doctorId?: string;
}

// ─── Feature Gating ───────────────────────────────────────────────────────────

export interface FeatureCheckResult {
  allowed: boolean;
  overage: boolean;      // true when usage >= limit but overage is permitted
  overageUnits: number;  // units above the limit (0 if not over)
  remaining: number;     // how many units left before hitting limit (0 if at/over)
  limit: number;         // the plan limit for this feature
  current: number;       // current usage this period
}

// ─── Billing Cycle ────────────────────────────────────────────────────────────

export type BillingCycleStatus =
  | 'OPEN'             // current in-progress cycle
  | 'CLOSED'           // closed with no overage
  | 'PENDING_PAYMENT'  // closed with unpaid overage
  | 'CHARGED'          // overage paid successfully
  | 'FAILED';          // overage payment failed

/**
 * SaasCore_Table — CYCLE entity.
 * PK = USER#userId, SK = CYCLE#YYYY-MM#cycleId
 *
 * Created by monthly-close Lambda at the start of each new month.
 * Stores frozen usage snapshot and overage calculation for the closed period.
 */
export interface BillingCycleRecord {
  PK: string;                    // USER#userId
  SK: string;                    // CYCLE#YYYY-MM#cycleId
  entity: 'billing_cycle';
  cycleId: string;               // UUID
  userId: string;
  subscriptionId: string;
  period: string;                // YYYY-MM of the closed cycle
  startDate: string;             // ISO 8601
  endDate: string;               // ISO 8601
  status: BillingCycleStatus;
  frozenUsage: Record<string, number>;    // snapshot of usage at close
  includedLimits: Record<string, number>; // copy of limitsCached at close
  overageUnits: Record<string, number>;   // units above limit per feature
  overageAmount: number;                  // total overage cost in local currency
  overageCurrency: string;               // e.g. "PEN"
  paymentId?: string;
  consecutiveUnpaidCount: number;        // cycles with unpaid overage in a row
  createdAt: string;
  updatedAt: string;
}
