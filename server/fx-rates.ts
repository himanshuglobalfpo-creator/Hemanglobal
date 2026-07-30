// ============================================================================
// AUTOMATIC FX RATES (P3.7) — pluggable rate provider
// ============================================================================
// A provider fetches "base units per 1 foreign unit" for a set of currencies.
// The concrete provider is chosen by FX_RATES_PROVIDER (default exchangerate-
// host). Providers are injectable, so the scheduler and tests can supply their
// own without touching the network. Storage decides what to do with the rates
// (see refreshFxRatesForOrg) — crucially, a manually-entered rate is never
// overwritten by an automatic one.

import { logger } from "./logger";

export interface FxRateProvider {
  readonly name: string;
  // Returns { FOREIGN: baseUnitsPerForeign } for each symbol, as of `date`
  // (YYYY-MM-DD; defaults to latest). Throws on failure — callers treat a throw
  // as "leave existing rates intact".
  fetchRates(base: string, symbols: string[], date?: string): Promise<Record<string, number>>;
}

// exchangerate.host (ECB-backed, free). base=FOREIGN, symbols=BASE gives base
// units per 1 foreign unit directly, so we query per foreign currency.
class ExchangeRateHostProvider implements FxRateProvider {
  readonly name = "exchangerate.host";
  async fetchRates(base: string, symbols: string[], date?: string): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    const when = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "latest";
    for (const foreign of symbols) {
      if (foreign === base) continue;
      const url = `https://api.exchangerate.host/${when}?base=${encodeURIComponent(foreign)}&symbols=${encodeURIComponent(base)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`FX provider HTTP ${res.status} for ${foreign}->${base}`);
      const body = await res.json() as any;
      const rate = body?.rates?.[base];
      if (typeof rate !== "number" || !(rate > 0)) throw new Error(`FX provider returned no rate for ${foreign}->${base}`);
      out[foreign] = rate;
    }
    return out;
  }
}

// A no-op provider (FX_RATES_PROVIDER=none) — auto-fetch disabled.
class NullProvider implements FxRateProvider {
  readonly name = "disabled";
  async fetchRates(): Promise<Record<string, number>> { return {}; }
}

export function getFxProvider(): FxRateProvider {
  const which = (process.env.FX_RATES_PROVIDER || "exchangerate-host").toLowerCase();
  switch (which) {
    case "none": case "disabled": return new NullProvider();
    case "exchangerate-host": case "ecb": default:
      if (which !== "exchangerate-host" && which !== "ecb") logger.warn(`[fx] unknown FX_RATES_PROVIDER "${which}", defaulting to exchangerate-host`);
      return new ExchangeRateHostProvider();
  }
}
