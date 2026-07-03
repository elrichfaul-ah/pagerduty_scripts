# PagerDuty Scripts

A collection of Node.js utility scripts for auditing and managing a PagerDuty account via the [PagerDuty REST API v2](https://developer.pagerduty.com/api-reference/).

## Scripts

### `notifyMigrationComplete.js`

The primary migration-tracking script. It scans PagerDuty for all teams tagged `Complete` (applied by Terraform when a team's migration finishes), checks MongoDB to avoid duplicate notifications, and creates a PagerDuty incident on each newly-completed team's service.

**Dry-run is the default.** Pass `--execute` to create real incidents.

```bash
# Dry-run (default) — discovers teams, shows what would happen, writes audit records to MongoDB
node notifyMigrationComplete.js

# Execute — prompts for confirmation, then creates incidents and records results
node notifyMigrationComplete.js --execute

# Dry-run a single team (bypasses deduplication check — always re-notifies)
node notifyMigrationComplete.js --team NL-DDP-fundament

# Execute for a single team
node notifyMigrationComplete.js --team NL-DDP-fundament --execute
```

**Execute flow:**

1. Resolves the `Complete` tag in PagerDuty
2. Fetches all teams carrying that tag
3. Checks MongoDB — skips any team already notified (guaranteed once-only)
4. Looks up the first service for each remaining team
5. Prints a discovery table showing what will happen
6. **(Execute only)** Prompts `Proceed? [y/N]` — Enter or anything other than `y` aborts
7. Creates a `low`-urgency PagerDuty incident per team and records the result in MongoDB
8. Prints a final summary

**Deduplication guarantee:** The bulk run skips any team already recorded in MongoDB with `dryRun: false`. The `--team` flag intentionally bypasses this check so a single team can be re-notified at any time.

**Dry-run records:** Each dry-run writes `dryRun: true` documents to MongoDB for auditability. These do **not** block future dry-runs or real runs.

---

### `getTeams.js`

Lists teams in the PagerDuty account, with optional filtering by tag name.

- **No arguments** — prints every team in the account to the console.
- **One or more tag names** — prints only teams that match any of the given tags (union), showing which tags matched each team.

```bash
# List all teams
node getTeams.js

# List teams with a specific tag
node getTeams.js Complete

# List teams matching any of multiple tags
node getTeams.js Complete InProgress Review
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

Fetches all users, filters for pending invites, and writes a Markdown report to `pendingInvites.md` in the project root (overwriting any previous run).

```bash
node getPendingInvites.js
```

**Console output:**

```
Fetching all PagerDuty users...

Total users:          518
Accepted (active):    263
Pending (not logged): 255

Report written to /path/to/pagerduty_scripts/pendingInvites.md
```

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

# MongoDB connection string — default points to the local Docker container
MONGODB_URI=mongodb://localhost:27017
```

A **read-write** PagerDuty API token is required for `notifyMigrationComplete.js --execute`. A **read-only** token is sufficient for all other scripts.

---

## Project structure

```
pagerduty_scripts/
├── lib/
│   ├── pagerduty.js          # Shared PagerDuty API client (GET, POST, pagination)
│   └── db.js                 # MongoDB connection and team_notifications CRUD
├── notifyMigrationComplete.js # Migration notification script
├── getTeams.js               # Team listing / tag filtering
├── getPendingInvites.js      # Pending invite audit + Markdown report
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

---

## Implementation notes

- **Shared API client:** `lib/pagerduty.js` provides `pdGet`, `pdPost`, `fetchAllPages`, and domain helpers used by all scripts.
- **Automatic pagination:** `fetchAllPages()` handles PagerDuty's offset-based pagination transparently (100 records per page).
- **Tag resolution:** Tag names are matched case-insensitively with an exact client-side check, since PagerDuty's `?query=` does a substring match.
- **Service selection:** When a team has multiple services, the first result from `GET /services?team_ids[]=` is used.
- **Incident urgency:** Incidents are created with `urgency: low` so on-call engineers are not actively paged — the incident serves as a notification record.
