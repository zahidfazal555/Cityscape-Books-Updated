# Cityscape Books — Go-live guide

The code is feature-complete for v1: Requirements v1.3 with SPEC-FIXES v1.4 and ENGINEERING-STANDARDS H1–H6. This guide is what people must do to put it live. Steps marked **(Owner)** need Cityscape Decors; **(Release Approver)** is Zahid or Saravanan S (ENGINEERING-STANDARDS §8).

## 1. Merge the stacked pull requests (Release Approver)
PRs #1–#18 are stacked, each based on the one before. Merge them **in order** into `main` once CI is green on each. Then:
- Turn on branch protection for `main`:
  - require PRs;
  - require the `checks` and `image` CI jobs;
  - require one approval;
  - no force-push.
- Delete the merged feature branches.

## 2. Decisions needed (Owner)
| Decision | Needed for | Notes |
|---|---|---|
| Hosting provider, India region | app, Postgres 16, private volume for photos | Any container host with managed Postgres 16, point-in-time restore (PITR) and daily snapshots. Fill in RUNBOOKS §7. |
| Email provider (SMTP) | invites, password resets, security alerts | Any SMTP service with TLS (Amazon SES, Zoho ZeptoMail, Postmark…). Set up SPF/DKIM for the sending domain. |
| Domain | `APP_URL` | e.g. `books.cityscapedecors.in`, behind HTTPS. |
| Project cost visible without `pnl`? | Reports | Open question from PR #12. Today revenue and cost are shown; profit and margin are hidden. |

## 3. Environments (Release Approver)
Set up three environments, **dev, staging and production**. Each has its own database, photo volume and secrets (H5). Staging uses synthetic data only; production data is never copied down.

Secrets per environment (see `.env.example`):

| Name | Value |
|---|---|
| `DATABASE_URL` | a login role that is a member of `csd_app` (row-level security applies). The app and the scheduled jobs use it. |
| `DATABASE_ADMIN_URL` | the database owner / migration role: migrations and `bootstrap` only. No superuser or BYPASSRLS is needed. |
| `JWT_SECRET` | `openssl rand -base64 48` |
| `APP_URL` | public HTTPS URL |
| `MAIL_MODE=smtp`, `SMTP_URL`, `MAIL_FROM` | `smtps://…:465` or `smtp://…:587` (STARTTLS is enforced) |
| `ATTACHMENT_DIR` | a persistent, backed-up volume mounted into the container (default `/data/attachments`) |
| `TRUSTED_PROXIES` | number of proxies in front of the app (usually 1) |

The app refuses to start in production without real mail, `ATTACHMENT_DIR`, or a strong `JWT_SECRET`.

The migrations create `csd_app` as a NOLOGIN group. After the first migration, create the login role the app uses, once:
```sql
CREATE ROLE books_app LOGIN PASSWORD '<from the secret manager>' NOSUPERUSER NOBYPASSRLS;
GRANT csd_app TO books_app;
```
Then set `DATABASE_URL=postgres://books_app:…@host/db`.

Build images from a clean checkout. `.dockerignore` keeps `.env*`, keys and dumps out, but keep `prod.env` outside the repository anyway.

## 4. Build and deploy
```sh
docker build -t cityscape-books:vX.Y.Z .            # CI builds this on every PR
# behind a TLS-inspecting proxy: docker build --secret id=ca,src=ca.pem …
docker run --rm --env-file prod.env cityscape-books:vX.Y.Z pnpm --filter @csd/db migrate   # expand-only migrations
docker run -d --env-file prod.env -v photos:/data/attachments -p 127.0.0.1:3000:3000 cityscape-books:vX.Y.Z
```
- The health check is `GET /api/health`.
- Put HTTPS (TLS 1.2+) in front of the container. The app sends HSTS and a strict CSP.
- Publish the port on `127.0.0.1` (or a private network) only, never `-p 3000:3000`. Docker's port rules bypass the host firewall. A client reaching port 3000 directly could fake `X-Forwarded-For`, which evades the sign-in rate limits and the new-IP sign-in alert.
- The proxy must **append** the client address to `X-Forwarded-For` (nginx `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`; Caddy does this by default). `TRUSTED_PROXIES` is the number of such proxies; the app refuses to start in production with `0`.
- Every production deploy follows RUNBOOKS §4, the release checklist:
  - a backup snapshot first;
  - not on the 18th–20th, or in the last 2 days of the month;
  - the Release Approver's click.

## 5. Scheduled jobs (cron on the host, same image; cron times are UTC)
| Schedule | Command | Why |
|---|---|---|
| every 15 min | `pnpm jobs sla-sweep` | SLA alerts even when nobody has the app open |
| daily 21:00 UTC (02:30 IST) | `pnpm jobs verify-books` | every journal balances, trial balance is zero, no gaps in invoice numbers. Exit code 1 means alert the Release Approver (S2). |
| weekly | `pnpm jobs retention` | anonymise ticket caller name and phone 3 years after closure (§9) |

Example: `docker run --rm --env-file prod.env cityscape-books:vX.Y.Z pnpm jobs verify-books`.

Every job exits 1 when any company fails or any check finds a problem. If no company is visible, the job fails rather than passing. Send cron failures to the Release Approver.

Back up the database and the photo volume on the same schedule. The quarterly restore drill uses `pnpm verify:books` (RUNBOOKS §6).

## 6. First-time set-up (Owner, with the Release Approver)
1. Create the company and the Owner:
   ```sh
   docker run --rm --env-file prod.env cityscape-books:vX.Y.Z \
     pnpm jobs bootstrap "Cityscape Decors" "Saravanan S" owner@cityscapedecors.in
   ```
   It runs once: it refuses if a company already exists (`--another` overrides on purpose).
2. The Owner opens the app, clicks **Forgot password** and sets a strong password from the email.
3. **Settings:** legal name, GSTIN, state, address, phone, email and bank details. These print on every invoice (Technical Spec §13 open items).
4. **Users & security:** invite the Admin, Project Manager, Asst. Manager and Site Engineers. Set project access and any custom rights.
5. **Masters:** clients, vendors and projects. For projects already handed over, record the handover in the **Warranty register**.
6. **Opening balances** as on 1 Apr 2026: Cash, bank & UPI → Opening balance, for each account.
7. **Payroll:** add staff and workers with salaries and rates. The Owner's entries apply at once. Set TDS, PT and recovery instalments.
8. **Knowledge base:** care guides and reply templates.
9. Set the **books lock date** once the opening figures are checked.

## 7. Acceptance (UAT) on staging (Owner + Admin)
Run the UAT checklist (Requirements §6). Covered end-to-end by `apps/web/e2e`:
- quote → proforma → advance → invoice → paid;
- purchases and payments with approvals;
- site expenses from the phone;
- GST month and GSTR-1 JSON;
- payroll run and payslips;
- wages and contractor payments;
- support ticket → visit → cost approval.

Record the sign-off in the release issue.

## 8. After go-live (first 30 days)
- Watch error tracking and uptime. The incident process is in RUNBOOKS §5.
- File the first GSTR-1 from the downloaded JSON and compare it with the CA's working.
- Hold the first restore drill and log it in RUNBOOKS.
