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
    getNotifiedTeamIds,
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

    // ── Resolve service ───────────────────────────────────────────────────────
    console.log('Resolving team service...')
    const service = await getFirstServiceForTeam(team.id)
    if (!service) {
        throw new Error(
            `Team "${team.name}" has no services. Cannot create an incident.`
        )
    }
    console.log(`  Service: ${service.name} (${service.id})\n`)

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
    console.log('─'.repeat(64))
    if (dryRun) {
        console.log(`[DRY-RUN] Would notify: ${team.name}`)
    } else {
        console.log(`[EXECUTE] Will notify:  ${team.name}`)
    }
    console.log(`           Service:   ${service.name}`)
    console.log(`           Priority:  ${INCIDENT_PRIORITY}`)
    console.log(`           Urgency:   ${INCIDENT_URGENCY}`)
    console.log(`           OpsGenie:  ${opsgenieTeam.name}`)
    console.log('─'.repeat(64) + '\n')

    // ── Dry-run path ──────────────────────────────────────────────────────────
    if (dryRun) {
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
            `[DRY-RUN] Would also alert OpsGenie team: ${opsgenieTeam.name}`
        )
        console.log(
            'No incident was created. Run with --execute to create a real incident.'
        )
        return
    }

    // ── Execute path: confirmation prompt ────────────────────────────────────
    const answer = await prompt(
        `Notify "${team.name}" via PagerDuty incident? [y/N]: `
    )

    if (answer.toLowerCase() !== 'y') {
        console.log('\nAborted. No incident was created.')
        return
    }

    // ── Create incident ───────────────────────────────────────────────────────
    console.log('')
    const response = await createIncident({
        title: `Migration Complete: ${team.name}`,
        serviceId: service.id,
        body: INCIDENT_BODY,
        urgency: INCIDENT_URGENCY,
        priorityId,
        links: [{ href: RUNBOOK_URL, text: RUNBOOK_TEXT }],
    })

    const incidentId = response.incident.id

    // ── Create OpsGenie alert ─────────────────────────────────────────────────
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

        // ── Check MongoDB for already-notified teams ───────────────────────────
        const notifiedIds = await getNotifiedTeamIds()
        const alreadyDone = completeTeams.filter((t) => notifiedIds.has(t.id))
        const toProcess = completeTeams.filter((t) => !notifiedIds.has(t.id))

        // ── Resolve services for teams that need notification ──────────────────
        console.log(
            `\nResolving services for ${toProcess.length} team(s) to process...`
        )

        const toNotify = [] // { team, service, opsgenieTeam }
        const noService = [] // { team }
        const noOpsgenieTeam = [] // { team }

        for (const team of toProcess) {
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
        }

        // ── Print discovery table ──────────────────────────────────────────────
        console.log('\n' + '─'.repeat(64))
        console.log('Discovery Results')
        console.log('─'.repeat(64))

        if (toNotify.length > 0) {
            console.log(`\nWill notify (${toNotify.length}):`)
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
                `\nAlready notified — will skip (${alreadyDone.length}):`
            )
            alreadyDone.forEach((team) => console.log(`  - ${team.name}`))
        }

        console.log('\n' + '─'.repeat(64))
        console.log(
            `Summary: ${toNotify.length} to notify | ` +
                `${alreadyDone.length} already done | ` +
                `${noService.length} no service | ` +
                `${noOpsgenieTeam.length} no OpsGenie team`
        )
        console.log('─'.repeat(64) + '\n')

        if (toNotify.length === 0) {
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

            console.log(
                `\n[DRY-RUN] Complete. ${toNotify.length} dry-run record(s) written to MongoDB.`
            )
            console.log(
                'No incidents were created. Run with --execute to create real incidents.'
            )
            return
        }

        // ── Execute path: confirmation prompt ─────────────────────────────────
        const answer = await prompt(
            `${toNotify.length} team(s) will be notified via PagerDuty incidents. Proceed? [y/N]: `
        )

        if (answer.toLowerCase() !== 'y') {
            console.log('\nAborted. No incidents were created.')
            return
        }

        // ── Execute path: create incidents ────────────────────────────────────
        console.log('')

        const results = { notified: 0, errors: 0 }
        const errors = []

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
                    `  [NOTIFIED] ${team.name} — PD incident ${incidentId} | OpsGenie request ${opsgenieRequestId}`
                )
                results.notified++
            } catch (err) {
                // Per-team errors are non-fatal — log and continue so one bad team
                // does not block notifications for all remaining teams.
                console.error(`  [ERROR]    ${team.name} — ${err.message}`)
                errors.push({ team: team.name, error: err.message })
                results.errors++
            }
        }

        // ── Final summary ──────────────────────────────────────────────────────
        console.log('\n' + '─'.repeat(64))
        console.log('Run Complete (EXECUTE)')
        console.log('─'.repeat(64))
        console.log(`  Notified:                        ${results.notified}`)
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
    }
}

main().catch((err) => {
    console.error(`\nFatal error: ${err.message}`)
    process.exit(1)
})
