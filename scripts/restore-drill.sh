#!/usr/bin/env bash
# =============================================================================
# restore-drill.sh — PROVE a backup restores to a consistent ledger
# =============================================================================
# A backup you have never restored is a hope, not a backup. This script:
#   1. Obtains a dump — the latest from object storage (RESTORE_FROM_S3=1) or,
#      for a self-contained drill/CI, a fresh pg_dump of DATABASE_URL.
#   2. Restores it into a throwaway scratch database on the same server.
#   3. Runs the accounting-identity verifier against the RESTORED copy
#      (scripts/verify-accounting-identity.ts) — double-entry must still hold.
#   4. Drops the scratch database.
#
# Exit 0 only if the restore succeeded AND every invariant held. Wire this as a
# weekly CI job (see .github/workflows/restore-drill.yml) so recoverability is
# continuously proven, never assumed.
#
# Required env:  DATABASE_URL
# Optional:
#   RESTORE_FROM_S3=1   pull the latest dump from BACKUP_S3_BUCKET/<prefix>/LATEST
#   BACKUP_S3_BUCKET / BACKUP_S3_PREFIX / BACKUP_S3_ENDPOINT / AWS_* (with RESTORE_FROM_S3)
# =============================================================================
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL}"
SCRATCH_DB="restore_drill_$(date -u +%Y%m%d%H%M%S)_$$"
TMP="$(mktemp -d)"
DUMP="$TMP/restore.dump"

# Admin + scratch connection URLs: same server, different database name.
ADMIN_URL="$(printf '%s' "$DATABASE_URL" | sed -E 's#/[^/?]+(\?.*)?$#/postgres\1#')"
SCRATCH_URL="$(printf '%s' "$DATABASE_URL" | sed -E "s#/[^/?]+(\?.*)?\$#/${SCRATCH_DB}\1#")"

cleanup() {
  psql "$ADMIN_URL" -v ON_ERROR_STOP=0 -c "DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE);" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

if [ "${RESTORE_FROM_S3:-0}" = "1" ]; then
  : "${BACKUP_S3_BUCKET:?set BACKUP_S3_BUCKET for RESTORE_FROM_S3}"
  PREFIX="${BACKUP_S3_PREFIX:-logical}"
  ENDPOINT_ARG=()
  [ -n "${BACKUP_S3_ENDPOINT:-}" ] && ENDPOINT_ARG=(--endpoint-url "$BACKUP_S3_ENDPOINT")
  echo "→ resolving latest dump from s3://${BACKUP_S3_BUCKET}/${PREFIX}/LATEST …"
  LATEST_KEY="$(aws "${ENDPOINT_ARG[@]}" s3 cp "s3://${BACKUP_S3_BUCKET}/${PREFIX}/LATEST" - )"
  echo "→ downloading ${LATEST_KEY} …"
  aws "${ENDPOINT_ARG[@]}" s3 cp "s3://${BACKUP_S3_BUCKET}/${LATEST_KEY}" "$DUMP"
else
  echo "→ self-contained drill: pg_dump of DATABASE_URL …"
  pg_dump --format=custom --no-owner --no-privileges --file="$DUMP" "$DATABASE_URL"
fi

echo "→ creating scratch database ${SCRATCH_DB} …"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${SCRATCH_DB};" >/dev/null

echo "→ restoring dump into scratch …"
pg_restore --no-owner --no-privileges --dbname="$SCRATCH_URL" "$DUMP"

echo "→ verifying accounting identity on the RESTORED copy …"
VERIFY_DATABASE_URL="$SCRATCH_URL" npx tsx scripts/verify-accounting-identity.ts

echo "✅ restore drill passed — backup restores to a consistent, balanced ledger."
