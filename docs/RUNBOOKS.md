# Cityscape Books — Operational Runbooks

Owner of this file: IT / operations owner (see ENGINEERING-STANDARDS §8). Every drill and incident adds a row to the logs at the bottom.

## 1. Restore after accidental delete (target: 1 h)
1. Note the time just before the bad change (from `audit_log`).
2. Create a PITR restore of production **to a new instance** at that time. Never restore over production.
3. Export the affected rows from the restored instance and import them with a reviewed SQL script inside one transaction.
4. Run the trial-balance check and row counts for that company.
5. Record it in the incident log.

## 2. Full recovery after region or database loss (target: 4 h, data loss ≤ 15 min)
1. Declare an S1 incident.
2. Restore the latest PITR (or the nightly dump from the separate backup account) into the standby region.
3. Point the app at the new DB through the secret manager, and redeploy the current image tag.
4. Verify `/api/health`, sign-in, trial balance, last 10 audit rows and bill-photo access.
5. Tell users which entries after the restore point must be re-entered.

## 3. Failed deployment
1. Redeploy the previous image tag (GitHub Environment → re-run the previous release).
2. Migrations are expand-only, so the old code runs on the new schema. Do **not** roll the schema back.
3. If data was corrupted, go to runbook 1.

## 4. Release checklist (copy into each release issue)
- [ ] CI green on the release commit (typecheck, lint, unit, integration, e2e, gitleaks, audit, licences)
- [ ] Staging deploy + migrations OK; ZAP baseline has no new high findings
- [ ] UAT sign-off (features only)
- [ ] Pre-deploy backup snapshot ID: ______
- [ ] Rollback step written: previous tag ______
- [ ] Not in a GST filing window (18th–20th) or payroll window (last 2 days)
- [ ] Release notes + CHANGELOG + version tag
- [ ] Person on call for 2 h after release: ______
- [ ] Sentry and uptime checks quiet 30 min after deploy

## 5. Incident process
| Severity | Example | Response |
|---|---|---|
| S1 | App down, data loss, data leak | immediate; owner informed within 1 h |
| S2 | Posting wrong, GST figures wrong, a role can't work | same working day |
| S3 | Feature broken with a workaround | next release |
| S4 | Cosmetic | backlog |

Steps: identify → assess severity → assign owner → contain → restore → communicate → root cause (within 5 working days) → corrective action + regression test → close.
For a personal-data breach: also follow the DPDP notification duty (timeline to be confirmed by counsel).

## 6. Quarterly restore drill
Restore the latest nightly dump into staging, then run `pnpm verify:books` (trial balance, row counts, checksum of the invoice series). Record the duration below. A failed drill counts as an S2 incident.

## 7. Third-party processors
| Service | Purpose | Region | DPA |
|---|---|---|---|
| _TBD_ hosting | app + DB | India | |
| _TBD_ object storage | bills, photos, PDFs | India | |
| _TBD_ email | invites, resets | | |
| Sentry | error tracking (PII scrubbed) | | |

## Logs
### Restore drills
| Date | Backup used | Duration | Result | By |
|---|---|---|---|---|

### Incidents
| Date | Severity | Summary | Root cause | Fix / test | By |
|---|---|---|---|---|---|

## Bill photos (attachments)
- Stored outside the database under `ATTACHMENT_DIR` (required in production; the app refuses to start without it). Keys are `<company id>/<attachment id>`, created once and never overwritten; the `attachment` table holds type, size and SHA-256.
- Back the directory up with the database, on the same schedule; a restore needs both. Verify a sample after restore by comparing SHA-256 with `attachment.sha256`.
- Uploads are type-sniffed (JPEG, PNG, PDF only, ≤ 10 MB) and stripped of EXIF/GPS and text metadata before storage. Every view writes an audit row (H4).
- Moving to an S3-compatible bucket: implement `BlobStore` (`put`/`get`) for the bucket, copy the directory tree key-for-key, then switch the container in `apps/web/src/lib/server.ts`.
