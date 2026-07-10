// ============================================================================
// POSTGRES ERROR → FRIENDLY HTTP RESPONSE (BUG-004)
// ============================================================================
// The pg driver throws errors carrying a 5-character SQLSTATE `code` plus rich
// internals (constraint name, table, column, the offending value in `detail`).
// Surfacing any of that to an API client leaks schema shape and, worse, the
// raw value that violated a constraint. This module maps the handful of codes
// a well-formed request can still trigger into a short, safe message + status.
//
// Contract:
//   - Returns { status, message } for a recognized DB error, else null.
//   - The message is generic on purpose — NEVER interpolate err.detail,
//     err.message, err.constraint, err.table or err.column into it.
//   - Callers keep the FULL error (code, detail, constraint, stack) in the
//     structured logs; only the sanitized envelope reaches the client.
// ============================================================================

// A pg DatabaseError always carries a string `code`; app-level Errors we throw
// deliberately do not set one from this set, so a code match is a safe signal
// that this originated in the driver.
export interface FriendlyDbError {
  status: number;
  message: string;
}

// SQLSTATE codes we can turn into an actionable client message. Anything not
// listed here is treated as an unexpected fault (500) by the caller.
const CODE_MAP: Record<string, FriendlyDbError> = {
  // 23505 unique_violation — the values collide with an existing row. 409 is
  // the correct semantic (a conflict the client can resolve), and it matches
  // the duplicate-name flow (BUG-006).
  "23505": { status: 409, message: "A record with these details already exists." },
  // 23503 foreign_key_violation — references a row that doesn't exist, or the
  // row is still referenced elsewhere and can't be changed/removed.
  "23503": { status: 409, message: "This action conflicts with related records and can't be completed." },
  // 23502 not_null_violation — a required field was missing.
  "23502": { status: 400, message: "A required field is missing." },
  // 23514 check_violation — a value broke a data-integrity rule.
  "23514": { status: 400, message: "A value doesn't satisfy a data constraint." },
  // 22003 numeric_value_out_of_range — a number is too large for its column.
  "22003": { status: 400, message: "A number is too large for the field it's stored in." },
  // 22001 string_data_right_truncation — text exceeds the column's length.
  "22001": { status: 400, message: "A text value is too long." },
  // 22P02 invalid_text_representation — malformed input for the column type
  // (e.g. a non-numeric string bound to an integer column).
  "22P02": { status: 400, message: "A value has the wrong format." },
  // 40001 serialization_failure / 40P01 deadlock_detected — transient
  // concurrency faults the client can safely retry.
  "40001": { status: 409, message: "The operation conflicted with another change. Please retry." },
  "40P01": { status: 409, message: "The operation conflicted with another change. Please retry." },
};

// Extract a pg SQLSTATE from an error, following one level of wrapping — Drizzle
// (and some driver paths) nest the original pg error under `.cause`.
function pgCode(err: any): string | undefined {
  const direct = typeof err?.code === "string" ? err.code : undefined;
  if (direct && CODE_MAP[direct]) return direct;
  const wrapped = typeof err?.cause?.code === "string" ? err.cause.code : undefined;
  if (wrapped && CODE_MAP[wrapped]) return wrapped;
  return undefined;
}

// Returns a sanitized { status, message } for a recognized Postgres error, or
// null when the error is not a DB error we translate (caller decides the rest).
export function mapDbError(err: unknown): FriendlyDbError | null {
  const code = pgCode(err);
  return code ? CODE_MAP[code] : null;
}
