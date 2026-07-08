'use strict'

// ---------------------------------------------------------------------------
// Environment — load and validate before anything else.
// Fail fast: if a required variable is missing the error surfaces immediately
// at startup rather than deep inside a run after API calls have been made.
// ---------------------------------------------------------------------------

const dotenvResult = require('dotenv').config()
if (dotenvResult.error && dotenvResult.error.code !== 'ENOENT') {
    // ENOENT just means no .env file — that's fine if vars are exported in the shell.
    console.error(
        `Warning: could not load .env file: ${dotenvResult.error.message}`
    )
}

// Required for all modes
const REQUIRED_ENV = [
    'PAGERDUTY_API_KEY',
    'PAGERDUTY_FROM_EMAIL',
    'OPSGENIE_API_KEY',
]
const missingEnv = REQUIRED_ENV.filter(
    (k) => !process.env[k] || process.env[k].trim() === ''
)
if (missingEnv.length) {
    console.error(
        `Error: Missing required environment variable(s): ${missingEnv.join(', ')}`
    )
    console.error('Set them in the .env file or export them before running.')
    process.exit(1)
}

// ---------------------------------------------------------------------------
// Imports — after env validation so lib/pagerduty.js requireEnv() succeeds
// ---------------------------------------------------------------------------

const fs = require('fs')
const path = require('path')
const readline = require('readline')

const {
    getAllTeams,
    resolveTagId,
    getTeamIdsByTagId,
    getFirstServiceForTeam,
    createIncident,
    getTeamByName,
    resolvePriorityId,
} = require('./lib/pagerduty')

const {
    getTeamByName: getOpsgenieTeamByName,
    createAlert,
} = require('./lib/opsgenie')

const {
    connect,
    disconnect,
    getCoverageStatus,
    updateOpsgenieRequestId,
    recordNotification,
} = require('./lib/db')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COMPLETE_TAG = 'Complete'
const INCIDENT_URGENCY = 'high'
const INCIDENT_PRIORITY = 'P2'
const RUNBOOK_URL =
    'https://confluence-aholddelhaize.atlassian.net/wiki/spaces/EEP/pages/150787558943/Opsgenie+Pagerduty+Migration+Runbook'
const RUNBOOK_TEXT = 'Migration Runbook'
const INCIDENT_BODY =
    "Your team's migration to PagerDuty has been completed. " +
    'Please review your services, escalation policies, and on-call schedules ' +
    'to ensure everything is configured correctly. Contact "Support - Pagerduty" if you have any questions or need assistance. ' +
    `Runbook: ${RUNBOOK_URL}`

const OPSGENIE_ALERT_MESSAGE =
    "Your team's migration to PagerDuty is complete. You can now move forward with the validation. " +
    'Please review your services, escalation policies, and on-call schedules to ensure everything ' +
    `is configured correctly. Contact "Support - Pagerduty" if you have any questions. Runbook: ${RUNBOOK_URL}`

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
    const args = process.argv.slice(2)
    const execute = args.includes('--execute')
    const dryRun = !execute

    const teamFlagIndex = args.indexOf('--team')
    let teamName = null

    if (teamFlagIndex !== -1) {
        const candidate = args[teamFlagIndex + 1]
        // Reject missing or another flag accidentally used as the value
        if (!candidate || candidate.startsWith('--')) {
            console.error('Error: --team requires a team name argument.')
            console.error(
                '  Example: node notifyMigrationComplete.js --team NL-DDP-fundament'
            )
            process.exit(1)
        }
        teamName = candidate
    }

    return { dryRun, teamName }
}

// ---------------------------------------------------------------------------
// Prompt helper
// ---------------------------------------------------------------------------

function prompt(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        })
        rl.question(question, (answer) => {
            rl.close()
            resolve(answer.trim())
        })
    })
}

// ---------------------------------------------------------------------------
// Single-team flow
// ---------------------------------------------------------------------------

/**
 * Notify a single team by name.
 *
 * Applies smart coverage logic using MongoDB state:
 *   - PD ✔ + OpsGenie ✔  → already fully notified; exits cleanly
 *   - PD ✔ + OpsGenie ✗  → OpsGenie backfill only (no new PD incident)
 *   - Neither             → full notification (PD incident + OpsGenie alert)
 *
 * Throws on any unrecoverable error so the caller's finally{disconnect()} runs.
 */
async function runSingleTeam(teamName, dryRun, priorityId) {
    console.log(`Target team: "${teamName}"\n`)

    // ── Resolve team by name ─────────────────────────────────────────────────
    console.log('Looking up team in PagerDuty...')
    const team = await getTeamByName(teamName)
    if (!team) {
        throw new Error(
            `Team "${teamName}" not found in PagerDuty. ` +
                'Check the name is exact (case-insensitive match is used).'
        )
    }
    console.log(`  Found: ${team.name} (${team.id})\n`)

    // ── Verify Complete tag ───────────────────────────────────────────────────
    console.log(`Checking "${COMPLETE_TAG}" tag membership...`)
    const tag = await resolveTagId(COMPLETE_TAG)
    if (!tag) {
        throw new Error(`Tag "${COMPLETE_TAG}" not found in PagerDuty.`)
    }

    const taggedTeamIds = await getTeamIdsByTagId(tag.id)
    if (!taggedTeamIds.includes(team.id)) {
        throw new Error(
            `Team "${team.name}" does not have the "${COMPLETE_TAG}" tag. ` +
                'Migration must be marked Complete in Terraform before notifying.'
        )
    }
    console.log(`  Confirmed — team has the "${COMPLETE_TAG}" tag.\n`)

    // ── Check MongoDB coverage ────────────────────────────────────────────────
    console.log('Checking notification coverage in MongoDB...')
    const coverageMap = await getCoverageStatus()
    const coverage = coverageMap.get(team.id) || {
        hasPD: false,
        hasOpsGenie: false,
    }

    // Determine what action is needed
    const action =
        coverage.hasPD && coverage.hasOpsGenie
            ? 'already-done'
            : coverage.hasPD
              ? 'opsgenie-only'
              : 'both'

    if (action === 'already-done') {
        console.log(
            `  Team "${team.name}" has already been fully notified ` +
                `(PD ✔  OpsGenie ✔). Nothing to do.`
        )
        return
    }

    if (action === 'opsgenie-only') {
        console.log(
            '  PD incident already sent. Will backfill OpsGenie alert only.\n'
        )
    } else {
        console.log(
            '  No prior notification found. Will send to both channels.\n'
        )
    }

    // ── Resolve service (only needed for full notification) ───────────────────
    let service = null
    if (action === 'both') {
        console.log('Resolving team service...')
        service = await getFirstServiceForTeam(team.id)
        if (!service) {
            throw new Error(
                `Team "${team.name}" has no services. Cannot create an incident.`
            )
        }
        console.log(`  Service: ${service.name} (${service.id})\n`)
    }

    // ── Validate OpsGenie team ────────────────────────────────────────────────
    console.log('Validating OpsGenie team...')
    const opsgenieTeam = await getOpsgenieTeamByName(team.name)
    if (!opsgenieTeam) {
        throw new Error(
            `Team "${team.name}" not found in OpsGenie. ` +
                'Ensure the OpsGenie team name matches the PagerDuty team name exactly before notifying.'
        )
    }
    console.log(`  Confirmed — OpsGenie team "${opsgenieTeam.name}" exists.\n`)

    // ── Print intent ──────────────────────────────────────────────────────────
    const modeLabel = dryRun ? 'DRY-RUN' : 'EXECUTE'
    const verb = dryRun ? 'Would notify' : 'Will notify'
    console.log('─'.repeat(64))
    console.log(`[${modeLabel}] ${verb}: ${team.name}`)
    if (action === 'opsgenie-only') {
        console.log(
            `           Mode:     OpsGenie backfill (PD incident already sent)`
        )
    } else {
        console.log(`           Mode:     Both channels`)
        console.log(`           Service:  ${service.name}`)
        console.log(`           Priority: ${INCIDENT_PRIORITY}`)
        console.log(`           Urgency:  ${INCIDENT_URGENCY}`)
    }
    console.log(`           OpsGenie: ${opsgenieTeam.name}`)
    console.log('─'.repeat(64) + '\n')

    // ── Dry-run path ──────────────────────────────────────────────────────────
    if (dryRun) {
        if (action === 'both') {
            await recordNotification({
                teamId: team.id,
                teamName: team.name,
                serviceId: service.id,
                serviceName: service.name,
                incidentId: null,
                opsgenieRequestId: null,
                dryRun: true,
            })
            console.log('[DRY-RUN] Dry-run record written to MongoDB.')
            console.log(
                `[DRY-RUN] Would create PD incident on service: ${service.name}`
            )
            console.log(
                `[DRY-RUN] Would alert OpsGenie team: ${opsgenieTeam.name}`
            )
        } else {
            // opsgenie-only
            console.log(
                '[DRY-RUN] Would backfill OpsGenie alert (no new PD incident).'
            )
            console.log(
                `[DRY-RUN] Would alert OpsGenie team: ${opsgenieTeam.name}`
            )
        }
        console.log(
            '\nNo changes made. Run with --execute to send real notifications.'
        )
        return
    }

    // ── Execute path: confirmation prompt ────────────────────────────────────
    const channelDesc =
        action === 'opsgenie-only'
            ? 'OpsGenie backfill (no new PD incident)'
            : 'PagerDuty incident + OpsGenie alert'
    const answer = await prompt(
        `Notify "${team.name}" via ${channelDesc}? [y/N]: `
    )

    if (answer.toLowerCase() !== 'y') {
        console.log('\nAborted. No notifications were sent.')
        return
    }

    console.log('')

    // ── Execute: OpsGenie-only backfill ───────────────────────────────────────
    if (action === 'opsgenie-only') {
        const opsgenieRequestId = await createAlert({
            message: `Migration Complete: ${team.name}`,
            description: OPSGENIE_ALERT_MESSAGE,
            teamName: opsgenieTeam.name,
        })

        await updateOpsgenieRequestId(team.id, opsgenieRequestId)

        console.log(
            `[NOTIFIED] ${team.name} — OpsGenie backfill request ${opsgenieRequestId} (PD was already done)`
        )
        return
    }

    // ── Execute: full notification (both channels) ────────────────────────────
    const response = await createIncident({
        title: `Migration Complete: ${team.name}`,
        serviceId: service.id,
        body: INCIDENT_BODY,
        urgency: INCIDENT_URGENCY,
        priorityId,
        links: [{ href: RUNBOOK_URL, text: RUNBOOK_TEXT }],
    })

    const incidentId = response.incident.id

    const opsgenieRequestId = await createAlert({
        message: `Migration Complete: ${team.name}`,
        description: OPSGENIE_ALERT_MESSAGE,
        teamName: opsgenieTeam.name,
    })

    await recordNotification({
        teamId: team.id,
        teamName: team.name,
        serviceId: service.id,
        serviceName: service.name,
        incidentId,
        opsgenieRequestId,
        dryRun: false,
    })

    console.log(
        `[NOTIFIED] ${team.name} — PD incident ${incidentId} | OpsGenie request ${opsgenieRequestId}`
    )
}

// ---------------------------------------------------------------------------
// Bulk flow: discovery
// ---------------------------------------------------------------------------

/**
 * Fetches all teams tagged with COMPLETE_TAG, sorted alphabetically.
 * Throws on unrecoverable errors.
 */
async function fetchCompleteTeams() {
    console.log(`Resolving tag: "${COMPLETE_TAG}"...`)

    const tag = await resolveTagId(COMPLETE_TAG)
    if (!tag) {
        throw new Error(`Tag "${COMPLETE_TAG}" not found in PagerDuty.`)
    }

    console.log(`  Tag "${COMPLETE_TAG}" → ID: ${tag.id}\n`)

    const taggedTeamIds = await getTeamIdsByTagId(tag.id)
    if (taggedTeamIds.length === 0) {
        console.log(`No teams are currently tagged "${COMPLETE_TAG}".`)
        return []
    }

    console.log(
        `Fetching full team details (${taggedTeamIds.length} tagged)...`
    )
    const allTeams = await getAllTeams()
    const teamById = new Map(allTeams.map((t) => [t.id, t]))

    return taggedTeamIds
        .map((id) => teamById.get(id))
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name))
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    const { dryRun, teamName } = parseArgs()

    // ── Report capture ───────────────────────────────────────────────────────
    const reportLines = []
    const _origLog = console.log
    console.log = (...args) => {
        const line = args.map(String).join(' ')
        reportLines.push(line)
        _origLog(...args)
    }

    // ── Mode banner ──────────────────────────────────────────────────────────
    console.log('')
    if (dryRun) {
        console.log('Mode: DRY-RUN (default) — no incidents will be created')
        console.log('      Run with --execute to create real incidents.\n')
    } else {
        console.log('Mode: EXECUTE — incidents will be created in PagerDuty\n')
    }

    // ── Connect to MongoDB ───────────────────────────────────────────────────
    try {
        await connect()
    } catch (err) {
        console.error(`Failed to connect to MongoDB: ${err.message}`)
        console.error('Is the MongoDB container running?  docker compose up -d')
        process.exit(1)
    }

    // All paths below are wrapped in try/finally so disconnect() always runs,
    // even if an inner function throws instead of calling process.exit().
    try {
        // ── Resolve P2 priority once — shared by both bulk and single-team ─────
        console.log(`Resolving priority "${INCIDENT_PRIORITY}"...`)
        const priority = await resolvePriorityId(INCIDENT_PRIORITY)
        if (!priority) {
            throw new Error(
                `Priority "${INCIDENT_PRIORITY}" not found in PagerDuty.`
            )
        }
        console.log(`  Priority "${INCIDENT_PRIORITY}" → ID: ${priority.id}\n`)

        // ── Route: single-team vs bulk ─────────────────────────────────────────
        if (teamName) {
            await runSingleTeam(teamName, dryRun, priority.id)
            return
        }

        // ── Discover Complete teams ────────────────────────────────────────────
        const completeTeams = await fetchCompleteTeams()
        if (completeTeams.length === 0) return

        // ── Check MongoDB for per-team coverage state ──────────────────────────
        const coverageMap = await getCoverageStatus()

        // Partition teams into 5 buckets based on coverage + API lookups.
        const alreadyDone = [] // PD ✔ + OpsGenie ✔ — nothing to do
        const needsOpsGenieOnly = [] // PD ✔ + OpsGenie ✗ — backfill OpsGenie only
        const toNotify = [] // Neither            — send both channels
        const noService = [] // No PD service found
        const noOpsgenieTeam = [] // No OpsGenie team found (new or backfill)

        // Teams fully covered need no API lookups at all.
        const teamsToProcess = completeTeams.filter((t) => {
            const cov = coverageMap.get(t.id)
            if (cov && cov.hasPD && cov.hasOpsGenie) {
                alreadyDone.push(t)
                return false
            }
            return true
        })

        if (teamsToProcess.length > 0) {
            console.log(
                `\nResolving channels for ${teamsToProcess.length} team(s) to process...`
            )
        }

        for (const team of teamsToProcess) {
            const cov = coverageMap.get(team.id)
            const needsBothChannels = !cov || (!cov.hasPD && !cov.hasOpsGenie)

            if (needsBothChannels) {
                // New team: needs PD service + OpsGenie team
                const service = await getFirstServiceForTeam(team.id)
                if (!service) {
                    noService.push({ team })
                    continue
                }

                const opsgenieTeam = await getOpsgenieTeamByName(team.name)
                if (!opsgenieTeam) {
                    noOpsgenieTeam.push({ team })
                    continue
                }

                toNotify.push({ team, service, opsgenieTeam })
            } else {
                // PD done, OpsGenie missing: only need OpsGenie team lookup
                const opsgenieTeam = await getOpsgenieTeamByName(team.name)
                if (!opsgenieTeam) {
                    noOpsgenieTeam.push({ team })
                    continue
                }

                needsOpsGenieOnly.push({ team, opsgenieTeam })
            }
        }

        // ── Print discovery table ──────────────────────────────────────────────
        console.log('\n' + '─'.repeat(64))
        console.log('Discovery Results')
        console.log('─'.repeat(64))

        if (needsOpsGenieOnly.length > 0) {
            console.log(
                `\nOpsGenie backfill — PD done, OpsGenie missing (${needsOpsGenieOnly.length}):`
            )
            needsOpsGenieOnly.forEach(({ team, opsgenieTeam }) => {
                console.log(`  ~ ${team.name}`)
                console.log(`      OpsGenie: ${opsgenieTeam.name}`)
            })
        }

        if (toNotify.length > 0) {
            console.log(
                `\nFull notification — both channels (${toNotify.length}):`
            )
            toNotify.forEach(({ team, service, opsgenieTeam }) => {
                console.log(`  + ${team.name}`)
                console.log(`      Service:  ${service.name} (${service.id})`)
                console.log(`      OpsGenie: ${opsgenieTeam.name}`)
            })
        }

        if (noService.length > 0) {
            console.log(`\nNo service found — will skip (${noService.length}):`)
            noService.forEach(({ team }) => console.log(`  ! ${team.name}`))
        }

        if (noOpsgenieTeam.length > 0) {
            console.log(
                `\nNo OpsGenie team found — will skip (${noOpsgenieTeam.length}):`
            )
            noOpsgenieTeam.forEach(({ team }) =>
                console.log(`  ! ${team.name}`)
            )
        }

        if (alreadyDone.length > 0) {
            console.log(
                `\nAlready fully notified — will skip (${alreadyDone.length}):`
            )
            alreadyDone.forEach((team) => console.log(`  - ${team.name}`))
        }

        const totalActionable = needsOpsGenieOnly.length + toNotify.length
        console.log('\n' + '─'.repeat(64))
        console.log(
            `Summary: ${toNotify.length} full | ` +
                `${needsOpsGenieOnly.length} OpsGenie backfill | ` +
                `${alreadyDone.length} already done | ` +
                `${noService.length} no service | ` +
                `${noOpsgenieTeam.length} no OpsGenie team`
        )
        console.log('─'.repeat(64) + '\n')

        if (totalActionable === 0) {
            console.log('Nothing to do.')
            return
        }

        // ── Dry-run path ───────────────────────────────────────────────────────
        if (dryRun) {
            console.log('[DRY-RUN] Recording dry-run entries to MongoDB...\n')

            for (const { team, service, opsgenieTeam } of toNotify) {
                await recordNotification({
                    teamId: team.id,
                    teamName: team.name,
                    serviceId: service.id,
                    serviceName: service.name,
                    incidentId: null,
                    opsgenieRequestId: null,
                    dryRun: true,
                })
                console.log(
                    `  [DRY-RUN] Would notify: ${team.name} via service "${service.name}"`
                )
                console.log(
                    `  [DRY-RUN] Would also alert OpsGenie team: ${opsgenieTeam.name}`
                )
            }

            for (const { team, opsgenieTeam } of needsOpsGenieOnly) {
                console.log(
                    `  [DRY-RUN] Would backfill OpsGenie for: ${team.name} → ${opsgenieTeam.name}`
                )
            }

            console.log(
                `\n[DRY-RUN] Complete. ${toNotify.length} dry-run record(s) written to MongoDB.`
            )
            console.log(
                `[DRY-RUN] ${needsOpsGenieOnly.length} OpsGenie backfill(s) would be sent.`
            )
            console.log(
                'No incidents were created. Run with --execute to create real notifications.'
            )
            return
        }

        // ── Execute path: confirmation prompt ─────────────────────────────────
        const parts = []
        if (toNotify.length)
            parts.push(`${toNotify.length} full notification(s)`)
        if (needsOpsGenieOnly.length)
            parts.push(`${needsOpsGenieOnly.length} OpsGenie backfill(s)`)
        const answer = await prompt(
            `${parts.join(' + ')} will be sent. Proceed? [y/N]: `
        )

        if (answer.toLowerCase() !== 'y') {
            console.log('\nAborted. No notifications were sent.')
            return
        }

        // ── Execute path: send notifications ──────────────────────────────────
        console.log('')

        const results = { notified: 0, backfilled: 0, errors: 0 }
        const errors = []

        // OpsGenie backfill first (lower risk — no new PD incidents)
        for (const { team, opsgenieTeam } of needsOpsGenieOnly) {
            try {
                const opsgenieRequestId = await createAlert({
                    message: `Migration Complete: ${team.name}`,
                    description: OPSGENIE_ALERT_MESSAGE,
                    teamName: opsgenieTeam.name,
                })

                await updateOpsgenieRequestId(team.id, opsgenieRequestId)

                console.log(
                    `  [BACKFILL]  ${team.name} — OpsGenie request ${opsgenieRequestId}`
                )
                results.backfilled++
            } catch (err) {
                console.error(`  [ERROR]     ${team.name} — ${err.message}`)
                errors.push({ team: team.name, error: err.message })
                results.errors++
            }
        }

        // Full notifications (PD incident + OpsGenie alert)
        for (const { team, service, opsgenieTeam } of toNotify) {
            try {
                const response = await createIncident({
                    title: `Migration Complete: ${team.name}`,
                    serviceId: service.id,
                    body: INCIDENT_BODY,
                    urgency: INCIDENT_URGENCY,
                    priorityId: priority.id,
                    links: [{ href: RUNBOOK_URL, text: RUNBOOK_TEXT }],
                })

                const incidentId = response.incident.id

                const opsgenieRequestId = await createAlert({
                    message: `Migration Complete: ${team.name}`,
                    description: OPSGENIE_ALERT_MESSAGE,
                    teamName: opsgenieTeam.name,
                })

                await recordNotification({
                    teamId: team.id,
                    teamName: team.name,
                    serviceId: service.id,
                    serviceName: service.name,
                    incidentId,
                    opsgenieRequestId,
                    dryRun: false,
                })

                console.log(
                    `  [NOTIFIED]  ${team.name} — PD incident ${incidentId} | OpsGenie request ${opsgenieRequestId}`
                )
                results.notified++
            } catch (err) {
                // Per-team errors are non-fatal — log and continue so one bad team
                // does not block notifications for all remaining teams.
                console.error(`  [ERROR]     ${team.name} — ${err.message}`)
                errors.push({ team: team.name, error: err.message })
                results.errors++
            }
        }

        // ── Final summary ──────────────────────────────────────────────────────
        console.log('\n' + '─'.repeat(64))
        console.log('Run Complete (EXECUTE)')
        console.log('─'.repeat(64))
        console.log(`  Notified (both channels):        ${results.notified}`)
        console.log(`  OpsGenie backfill:               ${results.backfilled}`)
        console.log(`  Already done (skipped):          ${alreadyDone.length}`)
        console.log(`  No service (skipped):            ${noService.length}`)
        console.log(
            `  No OpsGenie team (skipped):      ${noOpsgenieTeam.length}`
        )
        console.log(`  Errors:                          ${results.errors}`)
        console.log('─'.repeat(64))

        if (errors.length > 0) {
            console.log('\nErrors:')
            errors.forEach(({ team, error }) =>
                console.log(`  ${team}: ${error}`)
            )
        }
    } finally {
        // Always disconnect — even if an unhandled throw reaches here.
        await disconnect()

        // ── Write report file ────────────────────────────────────────────────
        try {
            const reportsDir = path.resolve(__dirname, 'reports')
            fs.mkdirSync(reportsDir, { recursive: true })
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
            const mode = dryRun ? 'dry-run' : 'execute'
            const scope = teamName
                ? teamName.replace(/[^a-zA-Z0-9_-]/g, '_')
                : 'bulk'
            const reportFile = path.join(
                reportsDir,
                `report-${mode}-${scope}-${timestamp}.txt`
            )
            fs.writeFileSync(reportFile, reportLines.join('\n') + '\n', 'utf8')
            _origLog(`\nReport saved to: ${reportFile}`)
        } catch (writeErr) {
            _origLog(
                `\nWarning: could not write report file — ${writeErr.message}`
            )
        } finally {
            console.log = _origLog
        }
    }
}

main().catch((err) => {
    console.error(`\nFatal error: ${err.message}`)
    process.exit(1)
})
