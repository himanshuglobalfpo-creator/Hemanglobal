# LedgerLite — Operations Runbook (Backups, Restore, DR)

This runbook covers data durability and disaster recovery: how backups are
taken, how to restore, our recovery targets, and the region-failure procedure.
It is the document you open at 3am. Keep it current — a stale runbook is a
liability.

## Recovery targets

| Metric | Target | Mechanism |
|---|---|---|
| **RPO** (max data loss) | **≤ 15 min** | Continuous WAL archiving / PITR on managed Postgres. |
| **RTO** (time to restore service) | **≤ 2 h** | Restore from PITR or latest logical dump into a standby, repoint app. |
| Logical-dump freshness | ≤ 24 h | Nightly `pg_dump` to object storage (immutable). |
| Backup retention | 30 days | PITR window 30d; logical dumps Object-Lock 30d. |
| Restore proof | Weekly | Automated restore drill in CI (`.github/workflows/restore-drill.yml`). |

## Backup strategy (two independent layers)

1. **PITR — the primary.** Managed Postgres (RDS/Cloud SQL/Neon) with
   continuous WAL archiving and a **30-day** retention window. This delivers the
   ≤ 15 min RPO: you can restore to any second in the window. Self-hosted? Run
   **wal-g** (or pgBackRest) shipping base backups + WAL to object storage on
   the same 30-day retention.
2. **Nightly logical dump — the belt-and-suspenders.** `scripts/backup-logical.sh`
   runs a compressed custom-format `pg_dump` and uploads it to a **separate
   bucket under separate, write-only credentials** with **Object Lock
   (COMPLIANCE) + 30-day retain-until**. This survives a Postgres-provider
   account compromise, a bad `DROP`, and engine-version corruption that PITR
   alone can't (a logical dump is portable across major versions and providers).

   > **Why separate credentials/bucket?** The app's runtime S3 key (attachment
   > store) must NOT be able to read or delete backups. Compromise of the app
   > cannot touch the backup bucket. Object Lock means even the backup key
   > cannot delete a dump before its retention expires (ransomware-resistant).

Schedule the nightly job (cron/K8s CronJob/managed scheduler):
```
0 3 * * *  DATABASE_URL=… BACKUP_S3_BUCKET=ledgerlite-backups \
           AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… AWS_DEFAULT_REGION=… \
           bash scripts/backup-logical.sh
```

## Restore procedures

### A. Point-in-time restore (preferred — smallest data loss)
1. In the managed-Postgres console, **restore to a new instance** at the target
   timestamp (just before the incident). Never restore in place.
2. Verify the recovered instance: run the identity check against it —
   `VERIFY_DATABASE_URL=<new-instance-url> npx tsx scripts/verify-accounting-identity.ts`.
   It must print ✅ (books balance, no orphans, integer cents).
3. Run pending migrations if the app version is ahead: they auto-apply at boot,
   but you can dry-run by booting one app instance against the restored DB.
4. Repoint `DATABASE_URL` (secret manager) to the new instance; roll the app.
5. Confirm `/api/health/ready` = 200 and spot-check a few orgs' trial balances.

### B. Logical-dump restore (provider/region loss, or corruption PITR shares)
1. Provision a fresh Postgres in the surviving region.
2. `RESTORE_FROM_S3=1 BACKUP_S3_BUCKET=… DATABASE_URL=<new-db> bash scripts/restore-drill.sh`
   — this pulls the latest dump, restores into a **scratch** DB, and verifies
   identity. For a real restore (not a drill), restore into the live target:
   `pg_restore --no-owner --no-privileges --dbname="$DATABASE_URL" <dump>`.
3. Verify identity against the target, run migrations, repoint, roll (as A.3–A.5).

### C. Attachments
Attachment blobs live in object storage (S3/R2), encrypted at rest (AES-256-GCM)
— see README. Enable **versioning + cross-region replication** on that bucket so
a region loss doesn't lose files. The DB backup only holds the metadata index;
the bytes are recovered from the object store (or its replica).

## Region-failure procedure

1. **Declare.** On-call confirms the primary region is down (health checks red,
   provider status). Page the incident owner.
2. **Database.** Promote the cross-region read replica if one exists (fastest);
   otherwise run **Restore B** from the latest logical dump into the DR region.
3. **Attachments.** Point `S3_ENDPOINT`/bucket at the replica bucket in the DR
   region.
4. **App.** Deploy the app in the DR region (same image/tag), set `DATABASE_URL`
   + `S3_*` to the DR resources, wait for `/api/health/ready`.
5. **DNS/traffic.** Flip the load balancer / DNS to the DR region.
6. **Verify.** Run `verify-accounting-identity` against the DR DB; smoke-test
   login, invoice list, a report. Announce recovery.
7. **Failback.** Once the primary region returns, resync (logical dump → primary
   or re-establish replication), verify, and flip back during a low-traffic
   window.

## Roles & responsibilities

| Role | Owns |
|---|---|
| **On-call engineer** | First responder: declares the incident, executes this runbook, keeps the incident channel updated. |
| **Incident owner** (eng lead) | Decides PITR vs logical restore, approves DNS flip, owns comms. |
| **Platform/DBA** | Backup config (PITR window, wal-g), bucket Object-Lock, credential rotation, quarterly restore-drill review. |
| **Support/Success** | Customer comms and status page during RTO. |

## Verify the safety net is real

- **Weekly automated drill:** `restore-drill.yml` dumps → restores → verifies
  identity every Monday. A red run is a P1 — investigate before trusting backups.
- **Manual drill (any time):** `DATABASE_URL=<throwaway> bash scripts/restore-drill.sh`.
- **Quarterly game day:** execute the full region-failure procedure against
  staging end-to-end; time it against the ≤ 2 h RTO and update this doc.
