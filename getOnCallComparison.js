'use strict'

require('dotenv').config()

const fs = require('fs')
const path = require('path')

const { fetchAllPages, getAllTeams } = require('./lib/pagerduty')
const { ogGet } = require('./lib/opsgenie')

const OPSGENIE_REQUEST_INTERVAL_MS = 700

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function escapeMarkdown(value) {
    return String(value ?? '')
        .replace(/\|/g, '\\|')
        .replace(/\r?\n/g, ' ')
}

function addToMapSet(map, key, value) {
    if (!map.has(key)) map.set(key, new Set())
    map.get(key).add(value)
}

function getCoverage(pdTeam, ogTeam, pdActive, ogActive, ogLookupFailed) {
    if (!pdTeam) return 'PD Missing'
    if (ogLookupFailed) return 'Unknown'
    if (pdActive && ogActive) return 'Both'
    if (ogActive) return 'OG Only'
    return 'Unknown'
}

function writeReport(rows) {
    const now = new Date()
    const generatedAt =
        now.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
    const timestamp = now
        .toISOString()
        .slice(0, 19)
        .replace('T', '_')
        .replace(/:/g, '-')
    const reportsDir = path.join(__dirname, 'reports')
    const reportPath = path.join(
        reportsDir,
        `${timestamp}-on-call-comparison-report.md`
    )

    fs.mkdirSync(reportsDir, { recursive: true })

    const coverageOrder = {
        Unknown: 0,
        'PD Missing': 1,
        'OG Only': 2,
        Both: 3,
    }
    const sorted = [...rows].sort(
        (a, b) =>
            coverageOrder[a.coverage] - coverageOrder[b.coverage] ||
            a.team.localeCompare(b.team)
    )
    const counts = Object.fromEntries(
        Object.keys(coverageOrder).map((coverage) => [coverage, 0])
    )
    for (const row of sorted) counts[row.coverage]++

    const lines = [
        '# PagerDuty and Opsgenie On-Call Comparison',
        '',
        `_Generated: ${generatedAt}_`,
        '',
        'Only PagerDuty escalation level 1 is included. Teams are matched by exact name, case-insensitively.',
        '',
        '## Summary',
        '',
        '| Coverage | Teams |',
        '|---|---:|',
        `| Both | ${counts.Both} |`,
        `| OG Only | ${counts['OG Only']} |`,
        `| PD Missing | ${counts['PD Missing']} |`,
        `| Unknown | ${counts.Unknown} |`,
        `| **Total** | **${sorted.length}** |`,
        '',
        '## Teams',
        '',
        '| Team | PD On-Call | PD Schedule | OG On-Call | OG Schedule | Coverage |',
        '|---|---|---|---|---|---|',
        ...sorted.map(
            (row) =>
                `| ${escapeMarkdown(row.team)} | ${escapeMarkdown(row.pdUsers || 'N/A')} | ` +
                `${escapeMarkdown(row.pdSchedules || 'N/A')} | ${escapeMarkdown(row.ogUsers || 'N/A')} | ` +
                `${escapeMarkdown(row.ogSchedules || 'N/A')} | ${row.coverage} |`
        ),
        '',
    ]

    fs.writeFileSync(reportPath, lines.join('\n'), 'utf8')
    return reportPath
}

async function getPagerDutyData() {
    const [teams, policies, onCalls] = await Promise.all([
        getAllTeams(),
        fetchAllPages('/escalation_policies?include[]=teams', 'escalation_policies'),
        fetchAllPages(
            '/oncalls?include[]=users&include[]=schedules&include[]=escalation_policies',
            'oncalls'
        ),
    ])

    const teamIdsByPolicy = new Map()
    const policyNamesByTeam = new Map()
    for (const policy of policies) {
        const teamIds = (policy.teams || []).map((team) => team.id)
        teamIdsByPolicy.set(policy.id, teamIds)
        for (const teamId of teamIds) {
            addToMapSet(policyNamesByTeam, teamId, policy.name)
        }
    }

    const usersByTeam = new Map()
    const schedulesByTeam = new Map()
    for (const onCall of onCalls) {
        if (onCall.escalation_level !== 1) continue
        const teamIds = teamIdsByPolicy.get(onCall.escalation_policy.id) || []
        for (const teamId of teamIds) {
            addToMapSet(
                usersByTeam,
                teamId,
                onCall.user.email || onCall.user.summary || onCall.user.name
            )
            addToMapSet(
                schedulesByTeam,
                teamId,
                onCall.schedule?.summary || 'Direct user'
            )
        }
    }

    return {
        teams,
        policies,
        onCalls,
        policyNamesByTeam,
        usersByTeam,
        schedulesByTeam,
    }
}

async function getOpsgenieData() {
    const [teamsResponse, schedulesResponse] = await Promise.all([
        ogGet('/v2/teams'),
        ogGet('/v2/schedules'),
    ])
    const teams = teamsResponse.data || []
    const schedules = schedulesResponse.data || []
    const schedulesByTeam = new Map()

    for (const schedule of schedules) {
        const teamId = schedule.ownerTeam?.id
        if (!teamId) continue
        if (!schedulesByTeam.has(teamId)) schedulesByTeam.set(teamId, [])
        schedulesByTeam.get(teamId).push(schedule)
    }

    const usersByTeam = new Map()
    const activeSchedulesByTeam = new Map()
    const failedTeamIds = new Set()
    const enabledSchedules = schedules.filter((schedule) => schedule.enabled)

    for (let index = 0; index < enabledSchedules.length; index++) {
        const schedule = enabledSchedules[index]
        const teamId = schedule.ownerTeam?.id
        if (!teamId) continue

        try {
            const response = await ogGet(
                `/v2/schedules/${schedule.id}/on-calls?scheduleIdentifierType=id&flat=true`
            )
            const recipients = response.data?.onCallRecipients || []
            if (recipients.length > 0) {
                addToMapSet(activeSchedulesByTeam, teamId, schedule.name)
                for (const recipient of recipients) {
                    addToMapSet(usersByTeam, teamId, recipient)
                }
            }
        } catch (err) {
            failedTeamIds.add(teamId)
            console.warn(`  [WARN] ${schedule.name}: ${err.message}`)
        }

        if (index < enabledSchedules.length - 1) {
            await sleep(OPSGENIE_REQUEST_INTERVAL_MS)
        }
    }

    return {
        teams,
        schedules,
        schedulesByTeam,
        usersByTeam,
        activeSchedulesByTeam,
        failedTeamIds,
    }
}

function joinData(pd, og) {
    const pdByName = new Map(
        pd.teams.map((team) => [team.name.toLowerCase(), team])
    )
    const ogByName = new Map(
        og.teams.map((team) => [team.name.toLowerCase(), team])
    )
    const names = new Set([...pdByName.keys(), ...ogByName.keys()])
    const rows = []

    for (const name of names) {
        const pdTeam = pdByName.get(name)
        const ogTeam = ogByName.get(name)
        const pdUsers = pdTeam ? pd.usersByTeam.get(pdTeam.id) : null
        const pdSchedules = pdTeam ? pd.schedulesByTeam.get(pdTeam.id) : null
        const ogUsers = ogTeam ? og.usersByTeam.get(ogTeam.id) : null
        const ogSchedules = ogTeam
            ? og.activeSchedulesByTeam.get(ogTeam.id)
            : null
        const ogLookupFailed = ogTeam ? og.failedTeamIds.has(ogTeam.id) : false

        // An inactive or absent Opsgenie schedule does not represent a migrated
        // team for this comparison, so omit it from the report.
        if (!ogUsers?.size) continue

        rows.push({
            team: pdTeam?.name || ogTeam.name,
            pdUsers: pdUsers ? [...pdUsers].sort().join(', ') : '',
            pdSchedules: pdSchedules
                ? [...pdSchedules].sort().join(', ')
                : pdTeam && pd.policyNamesByTeam.has(pdTeam.id)
                  ? 'No active Level 1 on-call'
                  : '',
            ogUsers: ogUsers ? [...ogUsers].sort().join(', ') : '',
            ogSchedules: ogSchedules
                ? [...ogSchedules].sort().join(', ')
                : ogTeam && (og.schedulesByTeam.get(ogTeam.id) || []).length > 0
                  ? 'No active on-call'
                  : '',
            coverage: getCoverage(
                pdTeam,
                ogTeam,
                Boolean(pdUsers?.size),
                Boolean(ogUsers?.size),
                ogLookupFailed
            ),
        })
    }

    return rows
}

async function main() {
    console.log('Fetching PagerDuty and Opsgenie on-call data...')

    const pdPromise = getPagerDutyData()
    const ogPromise = getOpsgenieData()
    const [pd, og] = await Promise.all([pdPromise, ogPromise])
    const rows = joinData(pd, og)
    const reportPath = writeReport(rows)

    console.log(
        `Compared ${pd.teams.length} PagerDuty teams with ${og.teams.length} Opsgenie teams.`
    )
    console.log(`Report written to ${reportPath}`)
}

main().catch((err) => {
    console.error('Fatal error:', err.message)
    process.exit(1)
})
