'use strict'

// ---------------------------------------------------------------------------
// Environment — load and validate before anything else.
// ---------------------------------------------------------------------------

const dotenvResult = require('dotenv').config()
if (dotenvResult.error && dotenvResult.error.code !== 'ENOENT') {
    console.error(`Warning: could not load .env file: ${dotenvResult.error.message}`)
}

const REQUIRED_ENV = ['PAGERDUTY_API_KEY', 'PAGERDUTY_FROM_EMAIL', 'OPSGENIE_API_KEY']
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k] || process.env[k].trim() === '')
if (missingEnv.length) {
    console.error(`Error: Missing required environment variable(s): ${missingEnv.join(', ')}`)
    console.error('Set them in the .env file or export them before running.')
    process.exit(1)
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

const fs = require('fs')
const path = require('path')
const readline = require('readline')

const {
    getAllTeams,
    getTeamByName,
    resolveTagId,
    getTeamIdsByTagId,
} = require('./lib/pagerduty')

const { getTeamByName: getOpsgenieTeamByName, createAlert } = require('./lib/opsgenie')

const {
    connect,
    disconnect,
    recordFinalNotice,
    getNotifiedFinalNoticeTeamIds,
} = require('./lib/db')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COMPLETE_TAG = 'Complete'
const CONFIG_PATH  = path.join(__dirname, 'config', 'finalNotice.json')

const RUNBOOK_URL =
    'https://confluence-aholddelhaize.atlassian.net/wiki/spaces/EEP/pages/150787558943/Opsgenie+Pagerduty+Migration+Runbook'

const ALERT_DESCRIPTION =
    'On the 27th of July 2027, the ServiceNow integration will be enabled for PagerDuty for all teams. ' +
    'OpsGenie will then officially be deprecated. ' +
    'Make sure you are onboarded onto PagerDuty and all steps in the runbook have been followed. ' +
    RUNBOOK_URL

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
        if (!candidate || candidate.startsWith('--')) {
            console.error('Error: --team requires a team name argument.')
            console.error('  Example: node finalNotice.js --team NL-CTP-Fulfillment')
            process.exit(1)
        }
        teamName = candidate
    }

    return { dryRun, teamName }
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

function loadExclusions() {
    if (!fs.existsSync(CONFIG_PATH)) return new Set()
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    return new Set((raw.excludeTeams || []).map((n) => n.toLowerCase()))
}

// ---------------------------------------------------------------------------
// Prompt helper
// ---------------------------------------------------------------------------

function prompt(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        rl.question(question, (answer) => { rl.close(); resolve(answer.trim()) })
    })
}

// ---------------------------------------------------------------------------
// Bulk discovery — mirrors fetchCompleteTeams() from notifyMigrationComplete.js
// ---------------------------------------------------------------------------

async function fetchCompleteTeams() {
    console.log(`Resolving tag: "${COMPLETE_TAG}"...`)
    const tag = await resolveTagId(COMPLETE_TAG)
    if (!tag) throw new Error(`Tag "${COMPLETE_TAG}" not found in PagerDuty.`)
    console.log(`  Tag "${COMPLETE_TAG}" → ID: ${tag.id}\n`)

    const taggedTeamIds = await getTeamIdsByTagId(tag.id)
    if (taggedTeamIds.length === 0) {
        console.log(`No teams are currently tagged "${COMPLETE_TAG}".`)
        return []
    }

    console.log(`Fetching full team details (${taggedTeamIds.length} tagged)...`)
    const allTeams = await getAllTeams()
    const teamById = new Map(allTeams.map((t) => [t.id, t]))

    return taggedTeamIds
        .map((id) => teamById.get(id))
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name))
}

// ---------------------------------------------------------------------------
// Single-team flow — mirrors runSingleTeam() from notifyMigrationComplete.js
// ---------------------------------------------------------------------------

async function runSingleTeam(teamName, dryRun) {
    console.log(`Target team: "${teamName}"\n`)

    // Resolve team in PagerDuty
    console.log('Looking up team in PagerDuty...')
    const team = await getTeamByName(teamName)
    if (!team) {
        throw new Error(
            `Team "${teamName}" not found in PagerDuty. ` +
            'Check the name is exact (case-insensitive match is used).'
        )
    }
    console.log(`  Found: ${team.name} (${team.id})\n`)

    // Verify Complete tag
    console.log(`Checking "${COMPLETE_TAG}" tag membership...`)
    const tag = await resolveTagId(COMPLETE_TAG)
    if (!tag) throw new Error(`Tag "${COMPLETE_TAG}" not found in PagerDuty.`)
    const taggedTeamIds = await getTeamIdsByTagId(tag.id)
    if (!taggedTeamIds.includes(team.id)) {
        throw new Error(
            `Team "${team.name}" does not have the "${COMPLETE_TAG}" tag. ` +
            'The team must be marked Complete in Terraform before sending a final notice.'
        )
    }
    console.log(`  Confirmed — team has the "${COMPLETE_TAG}" tag.\n`)

    // Verify OpsGenie team exists
    console.log('Validating OpsGenie team...')
    const opsgenieTeam = await getOpsgenieTeamByName(team.name)
    if (!opsgenieTeam) {
        throw new Error(
            `Team "${team.name}" not found in OpsGenie. ` +
            'Ensure the OpsGenie team name matches the PagerDuty team name exactly.'
        )
    }
    console.log(`  Confirmed — OpsGenie team "${opsgenieTeam.name}" exists.\n`)

    // Check MongoDB deduplication
    console.log('Checking final notice history in MongoDB...')
    const alreadyNotified = await getNotifiedFinalNoticeTeamIds()
    const wasNotified = alreadyNotified.has(team.id)

    if (wasNotified) {
        console.log(`  ⚠  WARNING: "${team.name}" has already been sent a final notice.`)
        if (dryRun) {
            console.log('     Dry-run mode — no action taken.')
            console.log('     Run with --execute to send again despite previous notice.')
            return
        }
        const reAnswer = await prompt(`\n  Team has already been notified. Send again? [y/N]: `)
        if (reAnswer.toLowerCase() !== 'y') {
            console.log('\nAborted. No notification sent.')
            return
        }
        console.log('')
    } else {
        console.log('  No prior final notice found.\n')
    }

    // Print intent
    const modeLabel = dryRun ? 'DRY-RUN' : 'EXECUTE'
    const verb = dryRun ? 'Would alert' : 'Will alert'
    console.log('─'.repeat(64))
    console.log(`[${modeLabel}] ${verb}: ${team.name}`)
    console.log(`           Channel:  OpsGenie alert (P2)`)
    console.log(`           OpsGenie: ${opsgenieTeam.name}`)
    console.log(`           Message:  ServiceNow Enablement Notice: ${team.name}`)
    console.log('─'.repeat(64) + '\n')

    if (dryRun) {
        console.log('[DRY-RUN] Would send final notice to OpsGenie.')
        console.log('\nNo changes made. Run with --execute to send the real alert.')
        return
    }

    // Execute: confirmation prompt
    const answer = await prompt(`Send final notice to "${opsgenieTeam.name}" via OpsGenie? [y/N]: `)
    if (answer.toLowerCase() !== 'y') {
        console.log('\nAborted. No notification sent.')
        return
    }

    console.log('')

    const opsgenieRequestId = await createAlert({
        message: `ServiceNow Enablement Notice: ${team.name}`,
        description: ALERT_DESCRIPTION,
        teamName: opsgenieTeam.name,
    })

    await recordFinalNotice({
        teamId: team.id,
        teamName: team.name,
        opsgenieRequestId,
        dryRun: false,
    })

    console.log(`[NOTIFIED] ${team.name} — OpsGenie request ${opsgenieRequestId}`)
}

// ---------------------------------------------------------------------------
// Bulk flow
// ---------------------------------------------------------------------------

async function runBulk(dryRun) {
    const exclusions = loadExclusions()
    if (exclusions.size > 0) {
        console.log(`Exclusions loaded: ${exclusions.size} team(s) from ${CONFIG_PATH}`)
    }

    // Discover Complete-tagged teams from PagerDuty
    const completeTeams = await fetchCompleteTeams()
    if (completeTeams.length === 0) return

    // Apply exclusions
    const candidates = completeTeams.filter((t) => !exclusions.has(t.name.toLowerCase()))
    if (exclusions.size > 0) {
        console.log(`  ${completeTeams.length - candidates.length} team(s) excluded.\n`)
    }

    // Check MongoDB for already-notified teams
    console.log('Checking final notice history in MongoDB...')
    const alreadyNotifiedIds = await getNotifiedFinalNoticeTeamIds()
    console.log(`  ${alreadyNotifiedIds.size} team(s) already notified.\n`)

    // Classify teams
    const toNotify       = []
    const alreadyDone    = []
    const noOpsgenieTeam = []

    console.log(`Resolving OpsGenie teams for ${candidates.length} candidate(s)...`)
    for (const team of candidates) {
        if (alreadyNotifiedIds.has(team.id)) {
            alreadyDone.push(team)
            continue
        }
        const opsgenieTeam = await getOpsgenieTeamByName(team.name)
        if (!opsgenieTeam) {
            noOpsgenieTeam.push(team)
            continue
        }
        toNotify.push({ team, opsgenieTeam })
    }

    // Discovery table
    console.log('\n' + '─'.repeat(64))
    console.log('Discovery Results')
    console.log('─'.repeat(64))

    if (toNotify.length > 0) {
        console.log(`\nWill notify (${toNotify.length}):`)
        toNotify.forEach(({ team, opsgenieTeam }) => {
            console.log(`  + ${team.name}`)
            console.log(`      OpsGenie: ${opsgenieTeam.name}`)
        })
    }

    if (alreadyDone.length > 0) {
        console.log(`\nAlready notified — will skip (${alreadyDone.length}):`)
        alreadyDone.forEach((team) => console.log(`  - ${team.name}`))
    }

    if (noOpsgenieTeam.length > 0) {
        console.log(`\nNo OpsGenie team found — will skip (${noOpsgenieTeam.length}):`)
        noOpsgenieTeam.forEach((team) => console.log(`  ! ${team.name}`))
    }

    console.log('\n' + '─'.repeat(64))
    console.log(
        `Summary: ${toNotify.length} to notify | ` +
        `${alreadyDone.length} already done | ` +
        `${noOpsgenieTeam.length} no OpsGenie team`
    )
    console.log('─'.repeat(64) + '\n')

    if (toNotify.length === 0) {
        console.log('Nothing to do.')
        return
    }

    // Dry-run: log intent only, no DB write, no alerts sent
    if (dryRun) {
        console.log('[DRY-RUN] Would send final notices to:\n')
        toNotify.forEach(({ team }) => console.log(`  [DRY-RUN] Would alert: ${team.name}`))
        console.log(`\n[DRY-RUN] Complete. No alerts sent.`)
        console.log('Run with --execute to send real final notices.')
        return
    }

    // Execute: confirmation prompt
    const answer = await prompt(
        `Send final notice to ${toNotify.length} team(s) via OpsGenie? [y/N]: `
    )
    if (answer.toLowerCase() !== 'y') {
        console.log('\nAborted. No notifications sent.')
        return
    }

    console.log('')

    const results = { notified: 0, errors: 0 }
    const errors = []

    for (const { team, opsgenieTeam } of toNotify) {
        try {
            const opsgenieRequestId = await createAlert({
                message: `ServiceNow Enablement Notice: ${team.name}`,
                description: ALERT_DESCRIPTION,
                teamName: opsgenieTeam.name,
            })

            await recordFinalNotice({
                teamId: team.id,
                teamName: team.name,
                opsgenieRequestId,
                dryRun: false,
            })

            console.log(`  [NOTIFIED]  ${team.name} — OpsGenie request ${opsgenieRequestId}`)
            results.notified++
        } catch (err) {
            console.error(`  [ERROR]     ${team.name} — ${err.message}`)
            errors.push({ team: team.name, error: err.message })
            results.errors++
        }
    }

    // Final summary
    console.log('\n' + '─'.repeat(64))
    console.log('Run Complete (EXECUTE)')
    console.log('─'.repeat(64))
    console.log(`  Notified:                        ${results.notified}`)
    console.log(`  Already done (skipped):          ${alreadyDone.length}`)
    console.log(`  No OpsGenie team (skipped):      ${noOpsgenieTeam.length}`)
    console.log(`  Errors:                          ${results.errors}`)
    console.log('─'.repeat(64))

    if (errors.length > 0) {
        console.log('\nErrors:')
        errors.forEach(({ team, error }) => console.log(`  ${team}: ${error}`))
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    const { dryRun, teamName } = parseArgs()

    // Report capture
    const reportLines = []
    const _origLog = console.log
    console.log = (...args) => {
        const line = args.map(String).join(' ')
        reportLines.push(line)
        _origLog(...args)
    }

    // Mode banner
    console.log('')
    if (dryRun) {
        console.log('Mode: DRY-RUN (default) — no alerts will be sent')
        console.log('      Run with --execute to send real final notices.\n')
    } else {
        console.log('Mode: EXECUTE — final notices will be sent via OpsGenie\n')
    }

    // Connect to MongoDB
    try {
        await connect()
    } catch (err) {
        console.error(`Failed to connect to MongoDB: ${err.message}`)
        console.error('Is the MongoDB container running?  docker compose up -d')
        process.exit(1)
    }

    try {
        if (teamName) {
            await runSingleTeam(teamName, dryRun)
        } else {
            await runBulk(dryRun)
        }
    } finally {
        await disconnect()

        // Write report file
        try {
            const reportsDir = path.resolve(__dirname, 'reports')
            fs.mkdirSync(reportsDir, { recursive: true })
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
            const mode = dryRun ? 'dry-run' : 'execute'
            const scope = teamName
                ? teamName.replace(/[^a-zA-Z0-9_-]/g, '_')
                : 'bulk'
            const reportFile = path.join(reportsDir, `report-final-notice-${mode}-${scope}-${timestamp}.md`)
            fs.writeFileSync(reportFile, reportLines.join('\n') + '\n', 'utf8')
            _origLog(`\nReport saved to: ${reportFile}`)
        } catch (writeErr) {
            _origLog(`\nWarning: could not write report file — ${writeErr.message}`)
        } finally {
            console.log = _origLog
        }
    }
}

main().catch((err) => {
    console.error(`\nFatal error: ${err.message}`)
    process.exit(1)
})
