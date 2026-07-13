# PagerDuty Scripts

A collection of Node.js utility scripts for auditing and managing a PagerDuty account via the [PagerDuty REST API v2](https://developer.pagerduty.com/api-reference/) and the [OpsGenie REST API](https://docs.opsgenie.com/docs/api-overview).

## Reports

All generated reports are written to `reports/`.

| Run | Report | What it contains |
|---|---|---|
| `node getTeams.js` | `reports/teams-report.md` and `reports/teams-report.xlsx` | PagerDuty team names and migration status from the `Complete` and `WIP` tags |
| `node getPendingInvites.js` | `reports/pendingInvites.md` | PagerDuty users who were invited but have not logged in |
| `node getSuppressedServices.js` | `reports/suppressionReport.md` | Suppression rules found in legacy event rules, service orchestrations, and global orchestrations |
| `node getMigrationAlertStates.js` | `reports/<timestamp>-migration-alert-states-report.md` | Latest PagerDuty and OpsGenie alert state and risk for each notified application |
| `node notifyMigrationComplete.js` | `reports/report-dry-run-<scope>-<timestamp>.txt` | Full console log from a notification dry-run |
| `node notifyMigrationComplete.js --execute` | `reports/report-execute-<scope>-<timestamp>.txt` | Full console log from a real notification run |

The fixed-name reports (`teams-report`, `pendingInvites`, and `suppressionReport`) overwrite their previous version. Timestamped reports are retained as separate files. The `reports/` directory is excluded from Git.

### Migration alert risk

`getMigrationAlertStates.js` uses the latest real notification record per application and compares its current state in both systems:

| Risk | Meaning |
|---|---|
| `None` | Both channels are handled: PagerDuty is acknowledged/resolved and OpsGenie is acknowledged/closed |
| `Low` | At least one channel is handled, but the other remains open |
| `High` | PagerDuty is triggered and OpsGenie is open; neither channel has been handled |
| `Unknown` | A notification ID is missing or an API lookup failed |

Its application table contains `Application`, `PagerDuty State`, `Opsgenie State`, and `Risk`. The script is read-only and requires MongoDB plus both API keys.

---

## Scripts

### `notifyMigrationComplete.js`

The primary migration-tracking script. It scans PagerDuty for all teams tagged `Complete` (applied by Terraform when a team's migration finishes), checks MongoDB to determine what each team still needs, and sends a PagerDuty incident and/or OpsGenie alert accordingly.

**Dry-run is the default.** Pass `--execute` to create real incidents and alerts.

```bash
# Dry-run (default) — discovers teams, shows what would happen, writes audit records to MongoDB
node notifyMigrationComplete.js

# Execute — prompts for confirmation, then creates incidents and records results
node notifyMigrationComplete.js --execute

# Dry-run a single team — applies smart coverage check (same as bulk)
node notifyMigrationComplete.js --team NL-DDP-fundament

# Execute for a single team
node notifyMigrationComplete.js --team NL-DDP-fundament --execute
```

**Execute flow:**

1. Resolves the `Complete` tag in PagerDuty
2. Fetches all teams carrying that tag
3. Checks MongoDB coverage state — classifies each team into one of five buckets:
   - **Already done** (PD ✔ + OpsGenie ✔) — skipped
   - **OpsGenie backfill** (PD ✔ + OpsGenie ✗) — sends OpsGenie alert only, patches MongoDB record
   - **Full notification** (neither) — sends PD incident + OpsGenie alert, inserts new MongoDB record
   - **No service** — skipped with warning
   - **No OpsGenie team** — skipped with warning
4. Prints a discovery table showing what will happen per bucket
5. **(Execute only)** Prompts `Proceed? [y/N]` — Enter or anything other than `y` aborts
6. Sends OpsGenie backfills first, then full notifications; per-team errors are non-fatal
7. Prints a final summary

**Deduplication / smart coverage:** The bulk run and `--team` mode both check MongoDB to determine exactly what each team still needs. A team with both channels covered is skipped entirely. A team with only a PD incident gets an OpsGenie backfill without creating a duplicate PD incident.

**Dry-run records:** Each dry-run writes `dryRun: true` documents to MongoDB for auditability. These do **not** block future dry-runs or real runs.

---

### `getTeams.js`

Lists teams in the PagerDuty account, with optional filtering by tag name, and generates Markdown and Excel reports. Reported migration status only considers the `Complete` and `WIP` tags.

- **No arguments** — prints every team in the account to the console.
- **One or more tag names** — prints only teams that match any of the given tags (union), showing which tags matched each team.

```bash
# List all teams
node getTeams.js

# List teams with a specific tag
node getTeams.js Complete

# List teams matching any of multiple tags
node getTeams.js Complete WIP
```

**Example output:**

```
1. NL-CTP-Fulfillment
   ID:          PBIZI40
   Description: Team Fulfillment (All)
   Tags:        Complete
   URL:         https://aholddelhaize.eu.pagerduty.com/teams/PBIZI40
```

---

### `getPendingInvites.js`

Audits user accounts to identify users who have been sent a PagerDuty invitation but have never logged in (`invitation_sent === true`).

Fetches all users, filters for pending invites, and writes `reports/pendingInvites.md` (overwriting the previous report).

```bash
node getPendingInvites.js
```

**Console output:**

```
Fetching all PagerDuty users...

Total users:          518
Accepted (active):    263
Pending (not logged): 255

Report written to /path/to/pagerduty_scripts/reports/pendingInvites.md
```

---

### `getSuppressedServices.js`

Audits PagerDuty services and event orchestrations for active suppression rules. It checks legacy event rules, service-level orchestrations, and global orchestrations, then writes `reports/suppressionReport.md`.

```bash
node getSuppressedServices.js
```

---

### `getMigrationAlertStates.js`

Creates a current dual-channel engagement report for migration notifications. It joins the latest real MongoDB notification record per application to its PagerDuty incident and OpsGenie alert, calculates risk, and writes a timestamped Markdown report.

```bash
node getMigrationAlertStates.js
```

This script only reads data; it does not create or update incidents or alerts.

---

## Setup

### Prerequisites

- **Node.js 18 or higher** — all scripts use the native `fetch` API introduced in Node.js 18
- **npm**
- **Docker + Docker Compose** — for the local MongoDB container

### 1. Start MongoDB

```bash
docker compose up -d

# Verify it is running
docker compose ps

# Stop (data persists in the named volume)
docker compose down

# Full wipe including stored data
docker compose down -v
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Copy the values into `.env` (or export them in your shell):

```
# Required for all scripts
PAGERDUTY_API_KEY=your_api_key_here

# Required for notifyMigrationComplete.js (PagerDuty API requirement when creating incidents)
PAGERDUTY_FROM_EMAIL=your_email@example.com

# Required for notifyMigrationComplete.js and getMigrationAlertStates.js
OPSGENIE_API_KEY=your_opsgenie_api_key_here

# MongoDB connection string — default points to the local Docker container
MONGODB_URI=mongodb://localhost:27017
```

A **read-write** PagerDuty API token and a **write-enabled** OpsGenie API key are required for `notifyMigrationComplete.js --execute`. Read access to PagerDuty and OpsGenie is sufficient for `getMigrationAlertStates.js`.

---

## Project structure

```
pagerduty_scripts/
├── lib/
│   ├── pagerduty.js          # Shared PagerDuty API client (GET, POST, pagination)
│   ├── opsgenie.js           # Shared OpsGenie API client (GET, POST, pagination)
│   └── db.js                 # MongoDB connection and team_notifications CRUD
├── notifyMigrationComplete.js # Migration notification script
├── getTeams.js               # Team/tag audit + Markdown and Excel reports
├── getPendingInvites.js      # Pending invite Markdown report
├── getSuppressedServices.js  # Suppression-rule Markdown report
├── getMigrationAlertStates.js # PD/OpsGenie alert-state and risk report
├── reports/                  # Generated reports (not committed)
├── docker-compose.yml        # Local MongoDB container
├── .env                      # Environment variables (not committed)
└── package.json
```

---

## MongoDB schema

**Database:** `pagerduty_migration`
**Collection:** `team_notifications`

| Field | Type | Description |
|---|---|---|
| `teamId` | string | PagerDuty team ID |
| `teamName` | string | Human-readable team name |
| `serviceId` | string | PagerDuty service the incident was raised on |
| `serviceName` | string | Human-readable service name |
| `incidentId` | string \| null | PagerDuty incident ID (`null` for dry-run records) |
| `dryRun` | boolean | `true` = audit record only, `false` = real notification |
| `notifiedAt` | Date | Timestamp of the record |
| `opsgenieRequestId` | string \| null | OpsGenie async request ID (`null` for dry-run records; may be patched into older records by a backfill run) |
| `opsgenieNotifiedAt` | Date \| — | Set when `opsgenieRequestId` is patched into a pre-existing record via OpsGenie backfill |

---

## Implementation notes

- **Shared API clients:** `lib/pagerduty.js` provides `pdGet`, `pdPost`, `fetchAllPages`, and domain helpers. `lib/opsgenie.js` provides the equivalent for OpsGenie (`ogGet`, `ogPost`, `fetchAllPages`, `getTeamByName`, `createAlert`).
- **Automatic pagination:** `fetchAllPages()` handles offset-based pagination transparently in both clients (100 records per page, 200-page safety cap).
- **Tag resolution:** Tag names are matched case-insensitively with an exact client-side check, since PagerDuty's `?query=` does a substring match.
- **Service selection:** When a team has multiple services, the first result from `GET /services?team_ids[]=` is used.
- **Incident urgency:** Incidents are created with `urgency: high` and priority `P2` so they are visible but route through the standard on-call flow.
- **Smart coverage logic:** `lib/db.js` `getCoverageStatus()` reads the most-recent `dryRun: false` record per team and returns `{ hasPD, hasOpsGenie }`. Both the bulk run and `--team` mode use this to determine exactly what still needs to be sent — skipping what's already done, backfilling only the missing channel where applicable.
- **OpsGenie backfill:** Teams notified before OpsGenie integration was added have a real PagerDuty incident but no OpsGenie alert. The script detects these automatically and sends the missing OpsGenie alert only, patching the existing MongoDB record via `updateOpsgenieRequestId()`.
