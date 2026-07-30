// ============================================================================
// PLATFORM BILLING (P4.1) — subscriptions, dunning, entitlements
// ============================================================================
// SEPARATE from app-Stripe (customer invoice payments): its own key
// (PLATFORM_STRIPE_SECRET_KEY), its own webhook endpoint, its own columns on
// organizations. This module owns the billing STATE MACHINE (trial → active →
// past_due → read-only) and the entitlement checks; the Stripe SDK is only
// touched by the checkout/portal/webhook route handlers.

import { createRequire } from "node:module";
import type { Request, Response, NextFunction } from "express";
import { type FeatureKey, type Plan, planHasFeature, plansWithFeature, PLAN_SEAT_LIMITS } from "@shared/entitlements";
import { pool } from "./storage";
import { logger } from "./logger";

const require = createRequire(import.meta.url);
const GRACE_DAYS = 7;
const TRIAL_DAYS = 14;

// ---- Lazy platform Stripe client (never touched unless configured) ----
let platformStripe: any = null;
export function getPlatformStripe(): any | null {
  const key = process.env.PLATFORM_STRIPE_SECRET_KEY;
  if (!key) return null;
  if (!platformStripe) {
    const Stripe = require("stripe");
    platformStripe = new Stripe(key, { apiVersion: "2024-06-20" });
  }
  return platformStripe;
}
export function platformBillingConfigured(): boolean {
  return !!process.env.PLATFORM_STRIPE_SECRET_KEY;
}

// Map an env-configured price id → plan (for webhook subscription events).
export function planForPriceId(priceId: string | undefined): Plan | null {
  if (!priceId) return null;
  const map: Record<string, Plan> = {
    [process.env.PLATFORM_STRIPE_PRICE_STARTER || "_starter"]: "starter",
    [process.env.PLATFORM_STRIPE_PRICE_PLUS || "_plus"]: "plus",
    [process.env.PLATFORM_STRIPE_PRICE_ADVANCED || "_advanced"]: "advanced",
  };
  return map[priceId] ?? null;
}

// ---------------------------------------------------------------------------
// Billing state machine (pure, computed from the org row + now)
// ---------------------------------------------------------------------------
export type BillingRow = {
  plan: string; billingStatus: string; trialEndsAt: string | null; graceUntil: string | null; seatLimit: number;
};
export type BillingState = { plan: Plan; status: string; readOnly: boolean; reason: string | null; trialEndsAt: string | null; graceUntil: string | null; seatLimit: number };

// Derive the EFFECTIVE state. Read-only when: a trial has expired with no paid
// sub, OR dunning grace has elapsed, OR the subscription is canceled.
export function effectiveBillingState(org: any, now: Date = new Date()): BillingState {
  const plan = (org?.plan ?? "trial") as Plan;
  const status = org?.billingStatus ?? org?.billing_status ?? "trialing";
  const trialEndsAt = org?.trialEndsAt ?? org?.trial_ends_at ?? null;
  const graceUntil = org?.graceUntil ?? org?.grace_until ?? null;
  const seatLimit = org?.seatLimit ?? org?.seat_limit ?? PLAN_SEAT_LIMITS[plan] ?? 3;
  let readOnly = false; let reason: string | null = null;
  if (status === "active") {
    readOnly = false;
  } else if (status === "trialing") {
    if (trialEndsAt && now.getTime() > new Date(trialEndsAt).getTime()) { readOnly = true; reason = "trial_expired"; }
  } else if (status === "past_due") {
    if (!graceUntil || now.getTime() > new Date(graceUntil).getTime()) { readOnly = true; reason = "payment_failed"; }
  } else if (status === "canceled") {
    readOnly = true; reason = "canceled";
  }
  return { plan, status, readOnly, reason, trialEndsAt, graceUntil, seatLimit };
}

// ---------------------------------------------------------------------------
// State transitions (webhook + signup drive these)
// ---------------------------------------------------------------------------
export async function startTrial(orgId: number): Promise<void> {
  const trialEnds = new Date(Date.now() + TRIAL_DAYS * 86400_000).toISOString();
  await pool.query(
    `UPDATE organizations SET plan='trial', billing_status='trialing', trial_ends_at=$2, seat_limit=$3 WHERE id=$1`,
    [orgId, trialEnds, PLAN_SEAT_LIMITS.trial]
  );
}
export async function setBillingActive(orgId: number, plan: Plan, subscriptionId: string | null): Promise<void> {
  await pool.query(
    `UPDATE organizations SET plan=$2, billing_status='active', stripe_subscription_id=COALESCE($3, stripe_subscription_id), seat_limit=$4, grace_until=NULL WHERE id=$1`,
    [orgId, plan, subscriptionId, PLAN_SEAT_LIMITS[plan]]
  );
}
export async function setBillingPastDue(orgId: number): Promise<void> {
  const graceUntil = new Date(Date.now() + GRACE_DAYS * 86400_000).toISOString();
  await pool.query(`UPDATE organizations SET billing_status='past_due', grace_until=$2 WHERE id=$1`, [orgId, graceUntil]);
}
export async function setBillingCanceled(orgId: number): Promise<void> {
  await pool.query(`UPDATE organizations SET billing_status='canceled' WHERE id=$1`, [orgId]);
}

// Apply a platform webhook event to the org's billing state. Kept separate from
// signature verification so it is unit-testable without Stripe.
export async function applyPlatformEvent(orgId: number, type: string, priceId?: string): Promise<string> {
  switch (type) {
    case "customer.subscription.updated":
    case "customer.subscription.created": {
      const plan = planForPriceId(priceId) ?? "starter";
      await setBillingActive(orgId, plan, null);
      return `active:${plan}`;
    }
    case "customer.subscription.deleted":
      await setBillingCanceled(orgId);
      return "canceled";
    case "invoice.payment_failed":
      await setBillingPastDue(orgId);
      return "past_due";
    case "invoice.payment_succeeded":
    case "invoice.paid": {
      const plan = planForPriceId(priceId);
      if (plan) await setBillingActive(orgId, plan, null);
      else await pool.query(`UPDATE organizations SET billing_status='active', grace_until=NULL WHERE id=$1`, [orgId]);
      return "active";
    }
    default:
      logger.info(`[platform-billing] ignored event ${type}`);
      return "ignored";
  }
}

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------
export async function seatUsage(orgId: number): Promise<number> {
  return Number((await pool.query(`SELECT COUNT(*)::int AS c FROM org_memberships WHERE org_id=$1`, [orgId])).rows[0].c);
}
// Throws a 402-flagged error when adding one more member would exceed the seat
// limit. Used by the invite flow.
export async function assertSeatAvailable(org: any): Promise<void> {
  const { seatLimit, plan } = effectiveBillingState(org);
  const used = await seatUsage(org.id);
  if (used >= seatLimit) {
    const err: any = new Error(`Seat limit reached: your ${plan} plan includes ${seatLimit} seat(s) and ${used} are in use. Upgrade to add more.`);
    err.status = 402; err.code = "SEAT_LIMIT";
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
// Entitlement gate: 402 with plan info when the org's plan lacks the feature.
export function requireEntitlement(feature: FeatureKey) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.org) { res.status(403).json({ error: "No active organization." }); return; }
    const { plan } = effectiveBillingState(req.org);
    if (planHasFeature(plan, feature)) return next();
    res.status(402).json({
      error: `Your ${plan} plan does not include ${feature}. Upgrade to unlock it.`,
      code: "ENTITLEMENT_REQUIRED",
      feature, plan, requiredPlans: plansWithFeature(feature),
    });
  };
}
