// ============================================================================
// WEIGHTED-AVERAGE INVENTORY COSTING (pure, side-effect-free)
// ============================================================================
// The accounting-critical math behind stock tracking lives here as pure
// functions so it can be unit-tested in isolation AND reused verbatim by the
// storage layer. Everything is INTEGER CENTS and WHOLE units — no floats, no
// drift. The same discipline as shared/money.ts: convert dollars to cents once
// at the API boundary, then only integers cross this line.

export interface ItemCostState {
  /** Whole units on hand. */
  qtyOnHand: number;
  /** Weighted-average unit cost, in integer cents. */
  avgCostCents: number;
}

export interface PurchaseResult extends ItemCostState {
  /** Per-unit landed cost of THIS purchase, in integer cents (for the movement row). */
  unitCostCents: number;
}

/**
 * Apply a purchase of `qty` whole units whose TOTAL landed cost is `valueCents`
 * (the exact integer-cents amount debited to the Inventory Asset account, so
 * the running valuation ties to the GL). Recomputes the weighted-average unit
 * cost:  newAvg = round((oldQty*oldAvg + valueCents) / (oldQty + qty)).
 */
export function applyPurchase(state: ItemCostState, qty: number, valueCents: number): PurchaseResult {
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new Error("applyPurchase: qty must be a positive whole number of units");
  }
  if (!Number.isInteger(valueCents)) {
    throw new Error("applyPurchase: valueCents must be an integer (cents)");
  }
  const newQty = state.qtyOnHand + qty;
  const totalValueCents = state.qtyOnHand * state.avgCostCents + valueCents;
  // newQty > 0 here because qty > 0 and qtyOnHand only goes negative when
  // negative stock is explicitly allowed; a purchase always adds units.
  const avgCostCents = newQty !== 0 ? Math.round(totalValueCents / newQty) : 0;
  const unitCostCents = Math.round(valueCents / qty);
  return { qtyOnHand: newQty, avgCostCents, unitCostCents };
}

export interface SaleResult {
  /** Cost of goods sold for this sale, in integer cents: qty * avgCostCents. */
  cogsCents: number;
  /** Resulting on-hand quantity (may be negative if negative stock is allowed). */
  qtyOnHand: number;
}

/**
 * Cost a sale of `qty` whole units at the CURRENT weighted-average cost. The
 * average is unchanged by a sale — only purchases move it. COGS is exact:
 * qty * avgCostCents (integer × integer).
 */
export function costOfSale(state: ItemCostState, qty: number): SaleResult {
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new Error("costOfSale: qty must be a positive whole number of units");
  }
  return { cogsCents: qty * state.avgCostCents, qtyOnHand: state.qtyOnHand - qty };
}

export interface CogsComponent {
  cogsAccountId: number;
  inventoryAssetAccountId: number;
  cogsCents: number;
}
export interface JournalLineDraft {
  accountId: number;
  debit: number;
  credit: number;
  description?: string;
}

/**
 * Build the COGS journal-entry lines for one or more sold inventory items:
 * Dr COGS / Cr Inventory Asset for each component, grouped by account so the
 * entry is compact. The returned lines are guaranteed balanced (total debits ==
 * total credits == sum of cogsCents). Components with zero cost are skipped.
 * Returns [] when there is nothing to post.
 */
export function buildCogsJournalLines(components: CogsComponent[], description?: string): JournalLineDraft[] {
  const debitByAccount = new Map<number, number>();  // cogsAccountId -> cents
  const creditByAccount = new Map<number, number>(); // inventoryAssetAccountId -> cents
  for (const c of components) {
    if (c.cogsCents <= 0) continue;
    debitByAccount.set(c.cogsAccountId, (debitByAccount.get(c.cogsAccountId) ?? 0) + c.cogsCents);
    creditByAccount.set(c.inventoryAssetAccountId, (creditByAccount.get(c.inventoryAssetAccountId) ?? 0) + c.cogsCents);
  }
  const lines: JournalLineDraft[] = [];
  for (const [accountId, amt] of debitByAccount) {
    lines.push({ accountId, debit: amt, credit: 0, description });
  }
  for (const [accountId, amt] of creditByAccount) {
    lines.push({ accountId, debit: 0, credit: amt, description });
  }
  return lines;
}
