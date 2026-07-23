'use strict'

// ---------------------------------------------------------------------------
// Environment — load and validate before anything else.
// ---------------------------------------------------------------------------

const dotenvResult = require('dotenv').config()
if (dotenvResult.error && dotenvResult.error.code !== 'ENOENT') {
    console.error(`Warning: could not load .env file: ${dotenvResult.error.message}`)
}

const REQUIRED_ENV = ['OPSGENIE_API_KEY']
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

const { getTeamByName: getOpsgenieTeamByName, createAlert } = require('./lib/opsgenie')
const { connect, disconnect, recordDeprecationNotice, getNotifiedDeprecationTeams } = require('./lib/db')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG_PATH = path.join(__dirname, 'config', 'notifyOpsDeprecation.json')

const RUNBOOK_URL =
    'https://confluence-aholddelhaize.atlassian.net/wiki/spaces/EEP/pages/150787558943/Opsgenie+Pagerduty+Migration+Runbook'

const DEPRECATION_DESCRIPTION =
    "If you haven't yet, please migrate to PagerDuty NOW. " +
    'OpsGenie deprecation will be finalised on 27th of July 2027. ' +
    `Please follow the runbook here: ${RUNBOOK_URL}`

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
    const args = process.argv.slice(2)
    const execute = args.includes('--execute')
    const dryRun = !execute

    // --file <path>
    const fileFlagIndex = args.indexOf('--file')
    let filePath = null
    if (fileFlagIndex !== -1) {
        const candidate = args[fileFlagIndex + 1]
        if (!candidate || candidate.startsWith('--')) {
            console.error('Error: --file requires a file path argument.')
            console.error('  Example: node notifyOpsgenieDeprecation.js --file config/myteams.json')
            process.exit(1)
        }
        filePath = path.resolve(candidate)
    }

    // --team <name>
    const teamFlagIndex = args.indexOf('--team')
    let teamName = null
    if (teamFlagIndex !== -1) {
        const candidate = args[teamFlagIndex + 1]
        if (!candidate || candidate.startsWith('--')) {
            console.error('Error: --team requires a team name argument.')
            console.error('  Example: node notifyOpsgenieDeprecation.js --team NL-CTP-api_platform')
            process.exit(1)
        }
        teamName = candidate
    }

    if (filePath && teamName) {
        console.error('Error: --file and --team are mutually exclusive. Use one or the other.')
        process.exit(1)
    }

    return { dryRun, filePath, teamName }
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

function loadTeamList(filePath) {
    const resolvedPath = filePath || DEFAULT_CONFIG_PATH
    if (!fs.existsSync(resolvedPath)) {
        throw new Error(`Team list file not found: ${resolvedPath}`)
    }
    const raw = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'))
    if (!Array.isArray(raw.teams) || raw.teams.length === 0) {
        throw new Error(`No teams found in ${resolvedPath}. Expected { "teams": ["..."] }`)
    }
    return { teams: raw.teams, sourcePath: resolvedPath }
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
// Single-team flow
// ---------------------------------------------------------------------------

async function runSingleTeam(teamName, dryRun) {
    console.log(`Target team: "${teamName}"\n`)

    // Verify OpsGenie team exists
    console.log('Looking up team in OpsGenie...')
    const opsgenieTeam = await getOpsgenieTeamByName(teamName)
    if (!opsgenieTeam) {
        throw new Error(
            `Team "${teamName}" not found in OpsGenie. ` +
            'Check the name is exact (case-insensitive match is used).'
        )
    }
    console.log(`  Found: ${opsgenieTeam.name}\n`)

    // Check if already notified
    console.log('Checking deprecation notice history in MongoDB...')
    const alreadyNotified = await getNotifiedDeprecationTeams()
    const wasNotified = alreadyNotified.has(teamName.toLowerCase())

    if (wasNotified) {
        console.log(`  ⚠  WARNING: "${opsgenieTeam.name}" has already been sent a deprecation notice.`)
        if (dryRun) {
            console.log('     Dry-run mode — no action taken.')
            console.log('     Run with --execute to send again despite previous notice.')
            return
        }
        // In execute mode, ask explicitly before re-notifying
        const reAnswer = await prompt(`\n  Team has already been notified. Send again? [y/N]: `)
        if (reAnswer.toLowerCase() !== 'y') {
            console.log('\nAborted. No notification sent.')
            return
        }
        console.log('')
    } else {
        console.log('  No prior deprecation notice found.\n')
    }

    // Print intent
    const modeLabel = dryRun ? 'DRY-RUN' : 'EXECUTE'
    const verb = dryRun ? 'Would alert' : 'Will alert'
    console.log('─'.repeat(64))
    console.log(`[${modeLabel}] ${verb}: ${opsgenieTeam.name}`)
    console.log(`           Channel:  OpsGenie alert (P2)`)
    console.log(`           Message:  OpsGenie Deprecation Notice: ${opsgenieTeam.name}`)
    console.log('─'.repeat(64) + '\n')

    if (dryRun) {
        console.log('[DRY-RUN] Would send deprecation notice to OpsGenie.')
        console.log('\nNo changes made. Run with --execute to send the real alert.')
        return
    }

    // Execute: confirmation prompt
    const answer = await prompt(`Alert "${opsgenieTeam.name}" with deprecation notice? [y/N]: `)
    if (answer.toLowerCase() !== 'y') {
        console.log('\nAborted. No notification sent.')
        return
    }

    console.log('')

    const opsgenieRequestId = await createAlert({
        message: `OpsGenie Deprecation Notice: ${opsgenieTeam.name}`,
        description: DEPRECATION_DESCRIPTION,
        teamName: opsgenieTeam.name,
    })

    await recordDeprecationNotice({
        teamName: opsgenieTeam.name,
        opsgenieRequestId,
        dryRun: false,
    })

    console.log(`[NOTIFIED] ${opsgenieTeam.name} — OpsGenie request ${opsgenieRequestId}`)
}

// ---------------------------------------------------------------------------
// Bulk flow
// ---------------------------------------------------------------------------

async function runBulk(filePath, dryRun) {
    const { teams: teamNames, sourcePath } = loadTeamList(filePath)
    console.log(`Loaded ${teamNames.length} team(s) from ${sourcePath}\n`)

    // Check MongoDB for already-notified teams
    console.log('Checking deprecation notice history in MongoDB...')
    const alreadyNotifiedSet = await getNotifiedDeprecationTeams()
    console.log(`  ${alreadyNotifiedSet.size} team(s) already notified.\n`)

    // Classify teams
    const toNotify       = []  // OpsGenie team found, not yet notified
    const alreadyDone    = []  // already have a dryRun:false record
    const noOpsgenieTeam = []  // not found in OpsGenie

    console.log(`Resolving ${teamNames.length} team(s) in OpsGenie...`)
    for (const name of teamNames) {
        const opsgenieTeam = await getOpsgenieTeamByName(name)
        if (!opsgenieTeam) {
            noOpsgenieTeam.push(name)
            continue
        }
        if (alreadyNotifiedSet.has(name.toLowerCase())) {
            alreadyDone.push(opsgenieTeam.name)
            continue
        }
        toNotify.push(opsgenieTeam.name)
    }

    // Discovery table
    console.log('\n' + '─'.repeat(64))
    console.log('Discovery Results')
    console.log('─'.repeat(64))

    if (toNotify.length > 0) {
        console.log(`\nWill notify (${toNotify.length}):`)
        toNotify.forEach((name) => console.log(`  + ${name}`))
    }

    if (alreadyDone.length > 0) {
        console.log(`\nAlready notified — will skip (${alreadyDone.length}):`)
        alreadyDone.forEach((name) => console.log(`  - ${name}`))
    }

    if (noOpsgenieTeam.length > 0) {
        console.log(`\nNot found in OpsGenie — will skip (${noOpsgenieTeam.length}):`)
        noOpsgenieTeam.forEach((name) => console.log(`  ! ${name}`))
    }

    console.log('\n' + '─'.repeat(64))
    console.log(
        `Summary: ${toNotify.length} to notify | ` +
        `${alreadyDone.length} already done | ` +
        `${noOpsgenieTeam.length} not found in OpsGenie`
    )
    console.log('─'.repeat(64) + '\n')

    if (toNotify.length === 0) {
        console.log('Nothing to do.')
        return
    }

    // Dry-run: log intent only, no DB write, no alerts sent
    if (dryRun) {
        console.log('[DRY-RUN] Would send deprecation notices to:\n')
        toNotify.forEach((name) => console.log(`  [DRY-RUN] Would alert: ${name}`))
        console.log(`\n[DRY-RUN] Complete. No alerts sent.`)
        console.log('Run with --execute to send real deprecation notices.')
        return
    }

    // Execute: confirmation prompt
    const answer = await prompt(
        `Send deprecation notice to ${toNotify.length} team(s)? [y/N]: `
    )
    if (answer.toLowerCase() !== 'y') {
        console.log('\nAborted. No notifications sent.')
        return
    }

    console.log('')

    // Send alerts
    const results = { notified: 0, errors: 0 }
    const errors = []

    for (const name of toNotify) {
        try {
            const opsgenieRequestId = await createAlert({
                message: `OpsGenie Deprecation Notice: ${name}`,
                description: DEPRECATION_DESCRIPTION,
                teamName: name,
            })

            await recordDeprecationNotice({
                teamName: name,
                opsgenieRequestId,
                dryRun: false,
            })

            console.log(`  [NOTIFIED]  ${name} — OpsGenie request ${opsgenieRequestId}`)
            results.notified++
        } catch (err) {
            console.error(`  [ERROR]     ${name} — ${err.message}`)
            errors.push({ team: name, error: err.message })
            results.errors++
        }
    }

    // Final summary
    console.log('\n' + '─'.repeat(64))
    console.log('Run Complete (EXECUTE)')
    console.log('─'.repeat(64))
    console.log(`  Notified:                        ${results.notified}`)
    console.log(`  Already done (skipped):          ${alreadyDone.length}`)
    console.log(`  Not found in OpsGenie (skipped): ${noOpsgenieTeam.length}`)
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
    const { dryRun, filePath, teamName } = parseArgs()

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
        console.log('      Run with --execute to send real deprecation notices.\n')
    } else {
        console.log('Mode: EXECUTE — deprecation notices will be sent via OpsGenie\n')
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
            await runBulk(filePath, dryRun)
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
                : path.basename(filePath || DEFAULT_CONFIG_PATH, '.json')
            const reportFile = path.join(reportsDir, `report-deprecation-${mode}-${scope}-${timestamp}.txt`)
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
