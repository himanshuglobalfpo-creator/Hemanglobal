// ============================================================================
// ENTITLEMENTS (P4.1) — plan → feature matrix
// ============================================================================
// The single source of truth for what each plan unlocks. Enforced server-side
// by requireEntitlement and reflected in the UI (locked badges + upgrade CTA).

export const PLANS = ["trial", "starter", "plus", "advanced"] as const;
export type Plan = (typeof PLANS)[number];

export const FEATURE_KEYS = ["multiCurrency", "payroll", "customRoles", "batchActions", "apiAccess"] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

// Feature sets per plan. Trial gets everything (so evaluation is unrestricted);
// paid tiers unlock progressively.
export const PLAN_ENTITLEMENTS: Record<Plan, FeatureKey[]> = {
  trial: ["multiCurrency", "payroll", "customRoles", "batchActions", "apiAccess"],
  starter: [],
  plus: ["multiCurrency", "batchActions"],
  advanced: ["multiCurrency", "payroll", "customRoles", "batchActions", "apiAccess"],
};

// Seat limits per plan.
export const PLAN_SEAT_LIMITS: Record<Plan, number> = {
  trial: 3, starter: 2, plus: 10, advanced: 50,
};

export function planHasFeature(plan: Plan, feature: FeatureKey): boolean {
  return (PLAN_ENTITLEMENTS[plan] ?? []).includes(feature);
}

// The lowest plan(s) that unlock a feature — surfaced in the 402 so the client
// can show a precise upgrade CTA.
export function plansWithFeature(feature: FeatureKey): Plan[] {
  return PLANS.filter((p) => p !== "trial" && planHasFeature(p, feature));
}
