// ============================================================================
// PAYROLL TAX ENGINE (pure, side-effect-free)
// ============================================================================
// The money-critical payroll math lives here as pure functions so it can be
// unit-tested in isolation and reused verbatim by the storage layer. Everything
// is INTEGER CENTS. YTD wages drive the annual wage-base caps (Social Security,
// FUTA/SUTA) and the Additional Medicare threshold, so a run computed later in
// the year is capped correctly.
//
// NOTE ON WITHHOLDING: real federal/state income-tax withholding uses the IRS
// Pub 15-T percentage-method tables and the employee's W-4. Like many SMB
// systems, this engine applies a per-employee flat withholding rate (e.g. the
// 22% supplemental rate, or a rate derived from the employee's W-4). Statutory
// FICA/FUTA rates and wage bases below are the 2024 U.S. figures and are
// overridable via PayrollTaxConfig.

export const PAY_FREQUENCIES = ["weekly", "biweekly", "semimonthly", "monthly"] as const;
export type PayFrequency = (typeof PAY_FREQUENCIES)[number];

export function periodsPerYear(freq: PayFrequency): number {
  switch (freq) {
    case "weekly": return 52;
    case "biweekly": return 26;
    case "semimonthly": return 24;
    case "monthly": return 12;
  }
}

export interface PayrollTaxConfig {
  socialSecurityRate: number;
  socialSecurityWageBaseCents: number;
  medicareRate: number;
  additionalMedicareRate: number;
  additionalMedicareThresholdCents: number;
  futaRate: number;
  futaWageBaseCents: number;
  sutaRate: number;
  sutaWageBaseCents: number;
}

// 2024 U.S. statutory defaults (overridable per run/org).
export const DEFAULT_PAYROLL_TAX_CONFIG: PayrollTaxConfig = {
  socialSecurityRate: 0.062,
  socialSecurityWageBaseCents: 168_600_00,
  medicareRate: 0.0145,
  additionalMedicareRate: 0.009,
  additionalMedicareThresholdCents: 200_000_00,
  futaRate: 0.006,
  futaWageBaseCents: 7_000_00,
  sutaRate: 0, // employer/state specific; 0 unless configured
  sutaWageBaseCents: 7_000_00,
};

export interface EmployeePayrollInput {
  /** Gross pay for THIS period, integer cents. */
  grossCents: number;
  /** Prior year-to-date gross for this employee (posted runs only), integer cents. */
  ytdGrossCents: number;
  /** Pre-tax deductions (e.g. 401k, section-125) — reduce income-tax wages. Integer cents. */
  preTaxCents?: number;
  /** Post-tax deductions (e.g. garnishments) — reduce net only. Integer cents. */
  postTaxCents?: number;
  /** Per-employee flat federal income-tax withholding rate (e.g. 0.22). */
  federalWithholdingRate: number;
  /** Per-employee flat state income-tax withholding rate (0 if none). */
  stateWithholdingRate: number;
  config?: Partial<PayrollTaxConfig>;
}

export interface EmployeePayrollResult {
  grossCents: number;
  preTaxCents: number;
  postTaxCents: number;
  // Employee-side (withheld from the paycheck)
  fedWithholdingCents: number;
  stateWithholdingCents: number;
  ssEmployeeCents: number;
  medicareEmployeeCents: number;
  additionalMedicareCents: number;
  employeeTaxCents: number;
  // Employer-side (company expense on top of gross)
  ssEmployerCents: number;
  medicareEmployerCents: number;
  futaCents: number;
  sutaCents: number;
  employerTaxCents: number;
  // Take-home
  netCents: number;
}

function cappedWage(grossCents: number, ytdCents: number, wageBaseCents: number): number {
  const remaining = Math.max(0, wageBaseCents - ytdCents);
  return Math.min(grossCents, remaining);
}

/**
 * Compute one employee's payroll for a single pay period, in integer cents.
 * Applies annual wage-base caps using YTD gross, so mid/late-year runs stop
 * withholding Social Security / FUTA / SUTA once the base is reached and start
 * Additional Medicare once the threshold is crossed.
 */
export function computeEmployeePayroll(input: EmployeePayrollInput): EmployeePayrollResult {
  const cfg = { ...DEFAULT_PAYROLL_TAX_CONFIG, ...(input.config ?? {}) };
  const gross = input.grossCents;
  const preTax = input.preTaxCents ?? 0;
  const postTax = input.postTaxCents ?? 0;
  if (!Number.isInteger(gross) || gross < 0) throw new Error("grossCents must be a non-negative integer");
  if (!Number.isInteger(preTax) || preTax < 0) throw new Error("preTaxCents must be a non-negative integer");
  if (!Number.isInteger(postTax) || postTax < 0) throw new Error("postTaxCents must be a non-negative integer");
  const ytd = input.ytdGrossCents;

  // Income-tax withholding is on wages net of pre-tax deductions.
  const taxableForIncome = Math.max(0, gross - preTax);
  const fedWithholdingCents = Math.round(taxableForIncome * input.federalWithholdingRate);
  const stateWithholdingCents = Math.round(taxableForIncome * input.stateWithholdingRate);

  // Social Security — capped at the annual wage base; employer matches.
  const ssWage = cappedWage(gross, ytd, cfg.socialSecurityWageBaseCents);
  const ssEmployeeCents = Math.round(ssWage * cfg.socialSecurityRate);
  const ssEmployerCents = ssEmployeeCents;

  // Medicare — uncapped; employer matches (no additional-Medicare on employer).
  const medicareEmployeeCents = Math.round(gross * cfg.medicareRate);
  const medicareEmployerCents = medicareEmployeeCents;

  // Additional Medicare (employee only) on wages above the YTD threshold.
  const over = ytd + gross - cfg.additionalMedicareThresholdCents;
  const addlWage = over <= 0 ? 0 : Math.min(gross, over);
  const additionalMedicareCents = Math.round(addlWage * cfg.additionalMedicareRate);

  // FUTA / SUTA — employer only, capped at their annual wage bases.
  const futaCents = Math.round(cappedWage(gross, ytd, cfg.futaWageBaseCents) * cfg.futaRate);
  const sutaCents = Math.round(cappedWage(gross, ytd, cfg.sutaWageBaseCents) * cfg.sutaRate);

  const employeeTaxCents = fedWithholdingCents + stateWithholdingCents + ssEmployeeCents + medicareEmployeeCents + additionalMedicareCents;
  const employerTaxCents = ssEmployerCents + medicareEmployerCents + futaCents + sutaCents;
  const netCents = gross - employeeTaxCents - preTax - postTax;

  return {
    grossCents: gross, preTaxCents: preTax, postTaxCents: postTax,
    fedWithholdingCents, stateWithholdingCents, ssEmployeeCents, medicareEmployeeCents, additionalMedicareCents,
    employeeTaxCents,
    ssEmployerCents, medicareEmployerCents, futaCents, sutaCents, employerTaxCents,
    netCents,
  };
}

/** Gross for a salaried employee in one period of the given frequency (integer cents). */
export function salaryGrossForPeriod(annualSalaryCents: number, freq: PayFrequency): number {
  return Math.round(annualSalaryCents / periodsPerYear(freq));
}

/** Gross for an hourly employee (integer cents). Hours may be fractional. */
export function hourlyGross(hourlyRateCents: number, hours: number): number {
  return Math.round(hourlyRateCents * hours);
}
