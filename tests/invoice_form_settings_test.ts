// ============================================================================
// INVOICE FORM SETTINGS (QBO "Manage" panel) + new invoice header/line fields
// ============================================================================
// Two halves:
//
//   (1) invoiceSettingsSchema — the org-level preferences contract:
//       parse({}) yields the full defaults, invalid values are rejected,
//       unknown keys are stripped, custom fields are capped at 3.
//   (2) Against real Postgres: an invoice created with shipTo / terms /
//       customFields / per-line serviceDate round-trips through
//       createInvoice → getInvoice, posts a balanced JE, and the settings
//       JSON persists on the organizations row.
//
// Run: tsx tests/invoice_form_settings_test.ts
// ============================================================================

import { setupTestDb } from "./harness";
import { invoiceSettingsSchema, defaultInvoiceSettings } from "../shared/schema";

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function main() {
  // ------------------------------------------------------------------------
  console.log("[1] invoiceSettingsSchema — defaults + validation");
  // ------------------------------------------------------------------------
  const d = invoiceSettingsSchema.parse({});
  check("parse({}) fills every default", d.customization.invoiceNo === true && d.customization.shipTo === false
    && d.tableColumns.description.show === true && d.tableColumns.description.label === "Description"
    && d.tableColumns.sku.show === false && d.paymentMethods.cards === true
    && d.paymentOptions.invoiceTotal === true && d.paymentOptions.discount === false
    && d.design.accentColor === "#16a34a" && d.scheduling.defaultTermsDays === 30
    && d.customFields.length === 0, JSON.stringify(d));
  check("defaultInvoiceSettings matches parse({})", JSON.stringify(defaultInvoiceSettings) === JSON.stringify(d));

  const custom = invoiceSettingsSchema.parse({
    customization: { shipTo: true },
    tableColumns: { sku: { show: true, label: "Item code" } },
    customFields: [{ name: "PO Number" }],
    design: { accentColor: "#2563eb" },
    scheduling: { defaultTermsDays: 15 },
  });
  check("partial input merges over defaults", custom.customization.shipTo === true
    && custom.customization.invoiceNo === true // untouched default survives
    && custom.tableColumns.sku.show === true && custom.tableColumns.sku.label === "Item code"
    && custom.tableColumns.qty.show === true // untouched column default survives
    && custom.customFields[0].name === "PO Number" && custom.customFields[0].active === true
    && custom.design.accentColor === "#2563eb" && custom.scheduling.defaultTermsDays === 15,
    JSON.stringify(custom));

  check("bad accent color rejected", !invoiceSettingsSchema.safeParse({ design: { accentColor: "green" } }).success);
  check("label over 30 chars rejected", !invoiceSettingsSchema.safeParse({ tableColumns: { qty: { show: true, label: "x".repeat(31) } } }).success);
  check("4th custom field rejected", !invoiceSettingsSchema.safeParse({ customFields: [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }] }).success);
  const stripped: any = invoiceSettingsSchema.parse({ hackField: true, customization: { invoiceNo: false } } as any);
  check("unknown keys are stripped", stripped.hackField === undefined && stripped.customization.invoiceNo === false);

  // ------------------------------------------------------------------------
  console.log("\n[2] Invoice with shipTo/terms/customFields/serviceDate (real PG)");
  // ------------------------------------------------------------------------
  const { pool, storage, seedOrgDefaults, withOrg, cleanup } = await setupTestDb("invoice_form");
  try {
    await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Form Co', 'form-co')`);
    await pool.query(`INSERT INTO users (email, password_hash, name) VALUES ('i@i.test', 'x', 'Form Tester')`);
    await seedOrgDefaults(1);
    const run = <T>(fn: () => Promise<T>) => withOrg({ orgId: 1, userId: 1 }, fn);

    const accts = await run(() => storage.listAccounts());
    const revenue = accts.find((a) => a.code === "4000")!;
    const customerId = (await pool.query(`INSERT INTO customers (org_id, name, email) VALUES (1, 'Ship Co', 'ship@co.test') RETURNING id`)).rows[0].id as number;

    const inv = await run(() => storage.createInvoice({
      customerId, date: "2026-07-01", dueDate: "2026-07-31", taxRate: 0,
      terms: "Net 30",
      shipTo: "42 Dock Street, Pier 7, Portland OR",
      customFields: { "PO Number": "PO-778", "Sales rep": "Dana" },
      lines: [
        { description: "Consulting", quantity: 2, rate: 150, incomeAccountId: revenue.id, serviceDate: "2026-06-28" },
        { description: "Support", quantity: 1, rate: 90, incomeAccountId: revenue.id },
      ],
    } as any));
    check("invoice created with the right total", inv.total === 39_000, String(inv.total));

    const got = (await run(() => storage.getInvoice(inv.id)))!;
    check("shipTo round-trips", got.shipTo === "42 Dock Street, Pier 7, Portland OR", String(got.shipTo));
    check("terms round-trips", got.terms === "Net 30", String(got.terms));
    check("customFields round-trip as JSON", JSON.parse(got.customFields || "{}")["PO Number"] === "PO-778"
      && JSON.parse(got.customFields || "{}")["Sales rep"] === "Dana", String(got.customFields));
    check("line serviceDate round-trips", got.lines[0].serviceDate === "2026-06-28" && got.lines[1].serviceDate === null,
      JSON.stringify(got.lines.map((l) => l.serviceDate)));

    // The invoice JE still balances and the TB holds.
    const tb = await run(() => storage.trialBalance());
    check("trial balance balanced", tb.totalDebit === tb.totalCredit, JSON.stringify({ dr: tb.totalDebit, cr: tb.totalCredit }));

    // Settings JSON persists on the org row and reads back validated.
    const toStore = invoiceSettingsSchema.parse({ customization: { shipTo: true }, customFields: [{ name: "PO Number" }] });
    await pool.query(`UPDATE organizations SET invoice_settings = $1 WHERE id = 1`, [JSON.stringify(toStore)]);
    const back = (await pool.query(`SELECT invoice_settings AS s FROM organizations WHERE id = 1`)).rows[0].s;
    const validated = invoiceSettingsSchema.parse(back);
    check("settings persist on organizations and re-validate", validated.customization.shipTo === true
      && validated.customFields[0].name === "PO Number" && validated.customization.invoiceNo === true,
      JSON.stringify(validated.customization));

    await pool.end();
  } finally {
    await cleanup();
  }

  if (failures) {
    console.error(`\n❌ ${failures} invoice-form-settings check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll invoice form settings tests passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
