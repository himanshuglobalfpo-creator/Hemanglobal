#!/usr/bin/env bash
# =============================================================================
# backup-logical.sh — nightly logical dump of the ledger → object storage
# =============================================================================
# Layer 2 of the backup strategy (layer 1 is managed-Postgres PITR / wal-g;
# see RUNBOOK.md). A pg_dump gives a portable, engine-version-tolerant copy we
# can restore into a scratch DB for drills and cross-region recovery.
#
# The dump lands in a SEPARATE bucket/prefix under SEPARATE credentials from the
# app's attachment store, so a compromised app key cannot reach or delete
# backups. Enable Object Lock (WORM) + a retention policy on that bucket so the
# uploaded object is immutable for the retention window (30 days recommended).
#
# Required env:
#   DATABASE_URL           source database
#   BACKUP_S3_BUCKET       destination bucket (Object-Lock enabled)
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_DEFAULT_REGION
#                          the BACKUP-only credentials (write-only if possible)
# Optional:
#   BACKUP_S3_PREFIX       default "logical"
#   BACKUP_S3_ENDPOINT     for R2/MinIO (e.g. https://<acct>.r2.cloudflarestorage.com)
#   BACKUP_RETENTION_DAYS  Object-Lock retain-until horizon, default 30
# =============================================================================
set -euo pipefail

: "${DATABASE_URL:?set DATABASE_URL}"
: "${BACKUP_S3_BUCKET:?set BACKUP_S3_BUCKET}"
PREFIX="${BACKUP_S3_PREFIX:-logical}"
RETAIN_DAYS="${BACKUP_RETENTION_DAYS:-30}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="ledgerlite-${TS}.dump"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ENDPOINT_ARG=()
[ -n "${BACKUP_S3_ENDPOINT:-}" ] && ENDPOINT_ARG=(--endpoint-url "$BACKUP_S3_ENDPOINT")

echo "→ pg_dump (custom format, compressed) …"
pg_dump --format=custom --compress=9 --no-owner --no-privileges --file="$TMP/$FILE" "$DATABASE_URL"

# Retain-until = now + N days, RFC3339. Requires Object Lock enabled on the bucket.
RETAIN_UNTIL="$(date -u -d "+${RETAIN_DAYS} days" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+"${RETAIN_DAYS}"d +%Y-%m-%dT%H:%M:%SZ)"

echo "→ upload s3://${BACKUP_S3_BUCKET}/${PREFIX}/${FILE} (retain until ${RETAIN_UNTIL}) …"
aws "${ENDPOINT_ARG[@]}" s3api put-object \
  --bucket "$BACKUP_S3_BUCKET" \
  --key "${PREFIX}/${FILE}" \
  --body "$TMP/$FILE" \
  --object-lock-mode COMPLIANCE \
  --object-lock-retain-until-date "$RETAIN_UNTIL" \
  >/dev/null || {
    echo "  (Object-Lock put failed — retrying without lock; ENABLE Object Lock on the bucket for immutability)"
    aws "${ENDPOINT_ARG[@]}" s3 cp "$TMP/$FILE" "s3://${BACKUP_S3_BUCKET}/${PREFIX}/${FILE}"
  }

# Write/refresh a pointer to the newest dump so restore-drill can find it O(1).
echo "${PREFIX}/${FILE}" > "$TMP/LATEST"
aws "${ENDPOINT_ARG[@]}" s3 cp "$TMP/LATEST" "s3://${BACKUP_S3_BUCKET}/${PREFIX}/LATEST" >/dev/null

echo "✅ backup complete: ${PREFIX}/${FILE}"
