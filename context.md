# Project Context

> This file is excluded from git (matched by `*.md` in `.gitignore`).
> It exists purely for developer orientation — background, current state, and decisions
> that aren't obvious from the code alone.

---

## What this project does

These scripts manage the notification side of a PagerDuty migration. When a team's
migration is complete, Terraform applies the `Complete` tag to the team in PagerDuty.
`notifyMigrationComplete.js` picks up all tagged teams and notifies them via two channels:

1. **PagerDuty** — a high-urgency P2 incident raised on the team's first service
2. **OpsGenie** — a P2 alert targeting the matching OpsGenie team by name

MongoDB (`pagerduty_migration.team_notifications`) is the source of truth for what has
already been sent, preventing duplicate notifications across runs.

---

## MongoDB state (audited July 2026)

| Metric | Count |
|---|---|
| Total records in `team_notifications` | 324 |
| Real notifications (`dryRun: false`) | 65 |
| Fully covered — PD ✔ + OpsGenie ✔ | 28 |
| PD only — OpsGenie alert missing | **37** |
| Dry-run records (`dryRun: true`) | 259 |

### The 37 PD-only teams

OpsGenie integration was added to the script after the initial bulk run had already
notified the first wave of teams. Those 37 teams received a PagerDuty incident but
no OpsGenie alert. Their MongoDB records have a valid `incidentId` but
`opsgenieRequestId` is either `null` or the field is absent entirely.

The script now detects these automatically via `getCoverageStatus()` in `lib/db.js`
and handles them as an **OpsGenie backfill** bucket — sending only the missing
OpsGenie alert and patching the existing record (no new PD incident is created).

**To remediate:**

```bash
# 1. Dry-run first — confirms all 37 appear in the backfill bucket
node notifyMigrationComplete.js

# 2. Execute — sends OpsGenie alerts for the 37 and patches their MongoDB records
node notifyMigrationComplete.js --execute
```

After a successful execute run, all 37 records will have both `incidentId` and
`opsgenieRequestId` populated, and a new `opsgenieNotifiedAt` timestamp.

---

## Smart coverage logic

`lib/db.js` `getCoverageStatus()` reads all `dryRun: false` records, sorts them
newest-first, and returns a `Map<teamId, { hasPD, hasOpsGenie, ... }>` keeping only
the most-recent record per team.

Both the bulk run and `--team` mode use this map to classify each team into one of
five buckets:

| Bucket | Condition | Action |
|---|---|---|
| Already done | PD ✔ + OpsGenie ✔ | Skip |
| OpsGenie backfill | PD ✔ + OpsGenie ✗ | Send OpsGenie alert only; patch record via `updateOpsgenieRequestId()` |
| Full notification | Neither | Send PD incident + OpsGenie alert; insert new record |
| No service | No PD service found | Skip with warning |
| No OpsGenie team | No matching OpsGenie team | Skip with warning |

`updateOpsgenieRequestId()` uses `findOneAndUpdate` (sorted by `notifiedAt: -1`)
with a filter of `$or: [{ $exists: false }, { null }]` so it correctly handles
both old records (field absent) and newer records (field explicitly null).

---

## `--team` flag behaviour change

**Before:** `--team <name>` bypassed all deduplication and always sent to both
channels, regardless of what MongoDB contained. This allowed deliberate
re-notification of an already-covered team.

**After:** `--team <name>` applies the same smart coverage logic as the bulk run:
- Already fully covered → exits cleanly with "already fully notified"
- PD only → OpsGenie backfill only
- Neither → full notification (both channels)

**Known gap:** There is no `--force` flag. If a team genuinely needs to be
re-notified on both channels (e.g. the original alert was missed), the only
workaround is to manually delete or update the MongoDB record before running
`--team --execute`.

---

## Environment variables

| Variable | Required by | Purpose |
|---|---|---|
| `PAGERDUTY_API_KEY` | All scripts | PagerDuty API auth (read-write for `--execute`, read-only otherwise) |
| `PAGERDUTY_FROM_EMAIL` | `notifyMigrationComplete.js` | Required `From:` header on PagerDuty POST requests |
| `OPSGENIE_API_KEY` | `notifyMigrationComplete.js` | OpsGenie API auth (write access required for alert creation) |
| `MONGODB_URI` | `notifyMigrationComplete.js` | Defaults to `mongodb://localhost:27017` |

---

## Key files

| File | Role |
|---|---|
| `lib/pagerduty.js` | PagerDuty API client — `pdGet`, `pdPost`, `fetchAllPages`, domain helpers |
| `lib/opsgenie.js` | OpsGenie API client — `ogGet`, `ogPost`, `fetchAllPages`, `getTeamByName`, `createAlert` |
| `lib/db.js` | MongoDB CRUD — `connect/disconnect`, `recordNotification`, `getCoverageStatus`, `updateOpsgenieRequestId` |
| `notifyMigrationComplete.js` | Main notification script — bulk + single-team flows |
| `getTeams.js` | List / filter teams by tag (read-only, no DB) |
| `getPendingInvites.js` | Audit users with pending invites, writes `pendingInvites.md` |
