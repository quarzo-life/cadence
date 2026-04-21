# cadence

Bidirectional sync between a Notion tasks database and the Google Calendars of
a Google Workspace. Runs as a Deno CLI on a 5-minute cron (Railway).

- **Notion → Google** — every dated task appears on the owner's primary
  calendar. Re-assignment moves the event; archival/deletion removes it.
- **Google → Notion** — events whose title starts with `NOTION` (configurable,
  word-boundary) on watched users' calendars become pages in the Notion DB.
  After initial ingestion the link is sealed via
  `extendedProperties.private.notion_page_id` and the event follows Notion.
- **Reconcile** — a full-scan pass, triggered every 24 h (default) from inside
  incremental runs, catches hard-deletes and drift.

See `SPEC.md` for the full behavioural contract.

## Stack

- Runtime: Deno 2.x
- Database: SQLite (via `jsr:@db/sqlite`)
- Notion SDK: `npm:@notionhq/client`
- Google Calendar auth: JWT RS256 + DWD, built on Web Crypto (no `googleapis`)

## Prerequisites

### Google Cloud

1. Enable the Google Calendar API on a project.
2. Create a service account (e.g. `notion-sync`).
3. Generate a JSON key — keep `client_email` and `private_key`. Note the
   numeric `client_id` too.
4. Admin Workspace → Security → API controls → Domain-Wide Delegation → add:
   - Client ID: the service account's numeric client id
   - Scope: `https://www.googleapis.com/auth/calendar` (exactly — any other
     scope causes the JWT exchange to fail).

### Notion

1. Create an internal integration at
   <https://www.notion.so/profile/integrations>.
2. Enable capabilities:
   - **Read user information including email addresses** (critical — emails
     resolve owners)
   - **Read / Update / Insert content**
3. Open the tasks database → `…` → Connections → add the integration.

### Notion DB schema

| Name (default) | Type | Required | Purpose |
| --- | --- | --- | --- |
| `Name` | Title | yes | Task title ↔ event summary |
| `Date` | Date | yes | Start/end ↔ event start/end |
| `Owner` | Person | yes | Owner email = target calendar |
| `Status` | Status or Select | optional | archived values trigger deletion |

Property names are configurable via env vars. The code **never** modifies the
Notion schema.

## Local development

```bash
curl -fsSL https://deno.land/install.sh | sh

cp .env.example .env     # fill in real secrets, never commit this file
deno task test           # unit tests
deno task dev            # watch mode
deno task start          # one incremental run
deno task reconcile      # standalone reconcile
```

## Configuration

Copy `.env.example` to `.env` (local) or set the same keys as Railway env
vars. Every variable is documented inline. Only `NOTION_TOKEN`,
`NOTION_DATABASE_ID`, `GOOGLE_SA_EMAIL` and `GOOGLE_SA_PRIVATE_KEY` are
required.

### The `GOOGLE_SA_PRIVATE_KEY` gotcha

Railway stores `\n` in env values as the two-character sequence `\n` rather
than as a real newline. `config.ts` already calls `.replace(/\\n/g, "\n")`
before handing the key to the PKCS8 importer, so paste the JSON-escaped value
as-is.

## Deploying to Railway

1. Push this repo to GitHub/GitLab and connect it to a new Railway project.
2. Add a **Volume** mounted on `/data` (1 GB is plenty). SQLite lives here
   (`DATABASE_PATH=/data/sync.db` by default).
3. Set every required env var from `.env.example` (service has no HTTP
   port — it's a cron script).
4. Configure the service's **Cron Schedule** to `*/5 * * * *`. One cron is
   enough: incremental runs trigger reconcile internally when due.
5. Deploy. Tail the logs for the first run — the structured lines look like:
   ```
   [2026-04-21T09:15:03.421Z] [info] run_start mode=incremental run_id=1
   [2026-04-21T09:15:03.892Z] [info] n2g_query found=3 since=2026-04-21T09:10:00.000Z
   [2026-04-21T09:15:04.700Z] [info] g2n_page_created event=xyz789 email=alice@co.com title="Q3 planning"
   [2026-04-21T09:15:05.300Z] [info] run_end mode=incremental run_id=1 status=success duration_ms=1880 …
   ```

### First run — seed window

On the first run per watched calendar the code fetches events in a **±10 day**
window to seed the `syncToken` (override of SPEC §8.6/§10 which wrote
-30/+365). All matching events in that window are ingested. If you want to
backfill a larger range, bump the `SEED_LOOKBACK_DAYS` / `SEED_LOOKAHEAD_DAYS`
constants in `sync-g2n.ts` before the first deploy.

### Backup

Snapshot the `/data` volume manually from the Railway dashboard. Automated
backups are out of scope for v1.

## Operations

### Inspect the state DB

Shell into the Railway service (or copy the file out) and run:

```bash
sqlite3 /data/sync.db "SELECT * FROM synced_tasks ORDER BY last_synced_at DESC LIMIT 10;"
sqlite3 /data/sync.db "SELECT id, mode, status, ended_at, errors FROM sync_runs ORDER BY id DESC LIMIT 10;"
sqlite3 /data/sync.db "SELECT * FROM google_sync_tokens;"
sqlite3 /data/sync.db "SELECT * FROM meta;"
```

### Force a reconcile

```bash
deno run --allow-net --allow-env --allow-read --allow-write --allow-ffi main.ts reconcile
```

This bumps `meta['last_reconcile']`; the next incremental runs won't
re-trigger the internal reconcile until the interval has elapsed again.

### Common failure modes

- **`missing required env var`** — one of the four required keys is not set.
  The script exits `1` before touching the DB.
- **`google token exchange failed … invalid_grant`** — check that the service
  account client id is in DWD with the exact scope
  `https://www.googleapis.com/auth/calendar`, and that the private key is not
  truncated (Railway quotes the JSON-escaped form).
- **Notion Person emails are `null`** — enable the "Read user information
  including email addresses" capability on the integration and reload it on
  the database. No code change is needed.
- **`SyncTokenExpiredError` on a watched calendar** — expected when Google
  invalidates a sync token (quiet periods, API rotation). The code deletes the
  stored token and re-seeds in one shot; logged as a `warn`, not an `error`.

## Scope — what's not in v1

Recurring events (RRULE), attendees, non-`primary` calendars, reminders, a
dashboard, versioned migrations, Prometheus metrics, automated backups, and
rich Notion page bodies on G→N ingestion. See SPEC §13 for the exhaustive
list.
