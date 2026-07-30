# LedgerLite — Performance & Load

Performance targets, how to reproduce them, and what we tuned.

## Targets (reference instance, 50 concurrent users)

| Endpoint class | Metric | Target |
|---|---|---|
| Lists (invoices, bills, bank tx, journal) + dashboard | p95 | **< 500 ms** |
| Reports (P&L, balance sheet, trial balance) | p95 | **< 2 s** |
| Error rate | `http_req_failed` | < 1% |

Reference org: **~100k journal lines**, 5k invoices, spread over ~2 years.

## Reproduce

```bash
# 1. Seed a large reference tenant (≈ seconds; set-based inserts).
DATABASE_URL=postgres://… npx tsx scripts/seed-loadtest.ts 50000   # 50k entries → 100k lines

# 2. Create a login for org 'loadtest-co', then drive load with k6:
k6 run -e BASE_URL=https://staging.example -e EMAIL=… -e PASSWORD=… \
       -e VUS=50 -e DURATION=2m loadtest/load.js
```

`loadtest/load.js` records two SLO trends — `list_latency` (p95 < 500ms) and
`report_latency` (p95 < 2s) — and **fails the run** if either threshold or the
error-rate threshold is exceeded.

## What we found & fixed

We `EXPLAIN ANALYZE`d the four heaviest queries at 100k lines:

1. **Report aggregation** (`journal_lines ⋈ journal_entries`, group by account) —
   the dominant cost. Each matching line was a **heap fetch** just to read
   `account_id, debit, credit`. **Fix:** migration `0046` adds
   `idx_jl_entry_covering ON journal_lines(entry_id) INCLUDE (account_id, debit,
   credit)` → the aggregation is now an **index-only scan**
   (`tests/query_plan_test.ts` guards this — no seq scan on `journal_lines`).
   A twin `idx_jl_org_account_covering` serves account-ledger / trial-balance
   aggregation the same way.
2. **List endpoints** (invoices/bills/bank tx/journal, paginated `ORDER BY date
   DESC, id DESC`) — already backed by the `idx_*_org_date_id` composite indexes
   (added earlier); they stay on an index range scan with `LIMIT`, no N+1
   (bank-tx category names are fetched in ONE batched query per page, not per
   row — see `server/storage.ts`).
3. **Dashboard** — a fixed set of small aggregates; org-scoped and indexed.
4. **Invoice/bill create** — write path, bounded by the balanced-JE insert; no
   scan concern.

## Large-org report exports

Report **CSV/PDF generation for large orgs** should run through the Phase-3 jobs
queue (`POST /api/jobs`, gated by the `batchActions` entitlement) rather than
inline on the request, so a multi-second export never holds a request/DB
connection open or trips the 30s request timeout. Interactive report JSON stays
inline (it meets the < 2s p95 target with the covering indexes above).

## Notes

- Metrics: watch `ledgerlite_http_request_duration_seconds` (p95) and
  `ledgerlite_pg_pool_waiting` during a run (see `OBSERVABILITY.md`); pool
  saturation is the first thing to give at high concurrency — raise
  `PG_POOL_MAX` and/or add a read replica for report traffic.
- Re-run the load test after any change to a list/report query or its indexes.
