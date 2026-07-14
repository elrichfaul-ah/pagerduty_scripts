'use strict'

require('dotenv').config()

const fs = require('fs')
const path = require('path')

const { connect, disconnect, getCoverageStatus } = require('./lib/db')
const { fetchAllPages, getAllTeams, resolveTagId, getTeamIdsByTagId, pdGet } = require('./lib/pagerduty')
const { ogGet } = require('./lib/opsgenie')

const CONFIG = require('./config/migration-teams.json')
const ALERT_CONCURRENCY = 2
const ACTION_LIMIT = 20

function mapWithConcurrency(items, limit, mapper) {
    const results = new Array(items.length)
    let nextIndex = 0

    async function worker() {
        while (nextIndex < items.length) {
            const index = nextIndex++
            results[index] = await mapper(items[index])
        }
    }

    return Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, () => worker())
    ).then(() => results)
}

function escapeMarkdown(value) {
    return String(value ?? '')
        .replace(/\|/g, '\\|')
        .replace(/\r?\n/g, ' ')
}

function dateStamp(date) {
    return date.toISOString().slice(0, 10)
}

async function getAlertHandling(coverage) {
    if (!coverage.hasPD || !coverage.hasOpsGenie) {
        return { pd: 'Missing', og: 'Missing', handled: false, unknown: false }
    }

    try {
        const [pdResponse, ogRequest] = await Promise.all([
            pdGet(`/incidents/${coverage.incidentId}`),
            ogGet(`/v2/alerts/requests/${encodeURIComponent(coverage.opsgenieRequestId)}`),
        ])
        const alertId = ogRequest.data?.alertId
        if (!alertId) throw new Error('Opsgenie request did not resolve to an alert')

        const ogResponse = await ogGet(
            `/v2/alerts/${encodeURIComponent(alertId)}?identifierType=id`
        )
        const pdStatus = pdResponse.incident.status
        const ogAlert = ogResponse.data
        const ogStatus = ogAlert.status === 'closed'
            ? 'Closed'
            : ogAlert.acknowledged
              ? 'Acknowledged'
              : 'Open'

        return {
            pd: pdStatus.charAt(0).toUpperCase() + pdStatus.slice(1),
            og: ogStatus,
            handled: ['acknowledged', 'resolved'].includes(pdStatus) &&
                (ogAlert.acknowledged || ogAlert.status === 'closed'),
            unknown: false,
        }
    } catch (err) {
        return { pd: 'Lookup failed', og: 'Lookup failed', handled: false, unknown: true }
    }
}

function findPreviousSnapshot(dailyDir, today) {
    if (!fs.existsSync(dailyDir)) return null

    const files = fs.readdirSync(dailyDir)
        .filter((file) => /^\d{4}-\d{2}-\d{2}-migration-snapshot\.json$/.test(file))
        .filter((file) => !file.startsWith(today))
        .sort()

    if (files.length === 0) return null
    return JSON.parse(fs.readFileSync(path.join(dailyDir, files.at(-1)), 'utf8'))
}

function classifyTeam(team) {
    if (!team.pdTeam) return { status: 'Not Started', issue: 'PagerDuty team is missing' }
    if (team.tags.includes('WIP') && !team.tags.includes('Complete')) {
        return { status: 'In Progress', issue: 'Migration is tagged WIP' }
    }
    if (!team.tags.includes('Complete')) {
        return { status: 'Not Started', issue: 'Migration tag is missing' }
    }
    if (!team.hasService) return { status: 'Blocked', issue: 'PagerDuty service is missing' }
    if (!team.hasPolicy) return { status: 'Blocked', issue: 'Escalation policy is missing' }
    if (!team.hasLevel1) return { status: 'Blocked', issue: 'Level 1 on-call is missing' }
    if (!team.hasPDNotification) return { status: 'Blocked', issue: 'PagerDuty notification is missing' }
    if (!team.hasOpsgenieNotification) return { status: 'Blocked', issue: 'Opsgenie notification is missing' }
    if (team.alerts.unknown) return { status: 'Unknown', issue: 'Alert status lookup failed' }
    if (!team.alerts.handled) return { status: 'Attention', issue: 'Both migration notifications require handling' }
    return { status: 'Ready', issue: '' }
}

function priorityFor(status) {
    if (status === 'Blocked' || status === 'Not Started') return 'Critical'
    if (status === 'Attention') return 'High'
    if (status === 'Unknown') return 'High'
    return 'Medium'
}

function requiredAction(status, issue) {
    if (status === 'Attention') return 'Contact team owner to handle both notifications'
    if (status === 'In Progress') return 'Complete migration configuration and apply Complete tag'
    if (status === 'Unknown') return 'Retry data collection and validate API access'
    if (issue === 'PagerDuty team is missing') return 'Create or map the PagerDuty team'
    if (issue === 'Migration tag is missing') return 'Confirm migration scope and apply the correct tag'
    if (issue === 'PagerDuty service is missing') return 'Create or assign a PagerDuty service'
    if (issue === 'Escalation policy is missing') return 'Create or assign an escalation policy'
    if (issue === 'Level 1 on-call is missing') return 'Configure an active Level 1 on-call schedule'
    if (issue === 'PagerDuty notification is missing') return 'Send or reconcile the PagerDuty notification'
    if (issue === 'Opsgenie notification is missing') return 'Send or reconcile the Opsgenie notification'
    return 'Resolve the listed migration prerequisite'
}

function writeOutputs(rows, priorSnapshot, excludedCount) {
    const now = new Date()
    const today = dateStamp(now)
    const dailyDir = path.join(__dirname, 'reports', 'daily')
    const reportPath = path.join(dailyDir, `${today}-migration-summary.md`)
    const snapshotPath = path.join(dailyDir, `${today}-migration-snapshot.json`)
    fs.mkdirSync(dailyDir, { recursive: true })

    const statuses = ['Ready', 'Attention', 'Blocked', 'In Progress', 'Not Started', 'Unknown']
    const counts = Object.fromEntries(statuses.map((status) => [status, 0]))
    for (const row of rows) counts[row.status]++

    const priorByTeam = new Map((priorSnapshot?.teams || []).map((team) => [team.name, team]))
    const newlyReady = rows.filter((row) => row.status === 'Ready' && priorByTeam.get(row.name)?.status !== 'Ready')
    const newBlockers = rows.filter((row) => row.status === 'Blocked' && !['Blocked', 'Not Started'].includes(priorByTeam.get(row.name)?.status))
    const resolvedBlockers = rows.filter((row) => {
        const prior = priorByTeam.get(row.name)?.status
        return ['Blocked', 'Not Started'].includes(prior) && !['Blocked', 'Not Started'].includes(row.status)
    })

    const complete = rows.filter((row) => row.tags.includes('Complete')).length
    const teamExists = rows.filter((row) => row.pdTeam).length
    const service = rows.filter((row) => row.hasService).length
    const level1 = rows.filter((row) => row.hasLevel1).length
    const bothSent = rows.filter((row) => row.hasPDNotification && row.hasOpsgenieNotification).length
    const bothHandled = rows.filter((row) => row.alerts.handled).length
    const readyPercentage = ((counts.Ready / rows.length) * 100).toFixed(1)
    const overall = counts.Ready / rows.length >= 0.95 && counts.Blocked === 0
        ? 'Green'
        : counts.Ready / rows.length >= 0.8 && counts.Blocked === 0
          ? 'Amber'
          : 'Red'

    const actions = rows
        .filter((row) => !['Ready', 'In Progress'].includes(row.status))
        .sort((a, b) => {
            const priority = { Critical: 0, High: 1, Medium: 2 }
            return priority[priorityFor(a.status)] - priority[priorityFor(b.status)] || a.name.localeCompare(b.name)
        })
        .slice(0, ACTION_LIMIT)

    const generatedAt = now.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
    const lines = [
        '# Opsgenie to PagerDuty Migration',
        '',
        `**Daily Summary - ${today}**`,
        '',
        `**Overall status:** ${overall}  `,
        `**Approved scope:** ${rows.length} teams  `,
        `**Fully ready:** ${counts.Ready} teams (${readyPercentage}%)  `,
        `**Data timestamp:** ${generatedAt}`,
        '',
        '## Status',
        '',
        '| Status | Teams |',
        '|---|---:|',
        ...statuses.map((status) => `| ${status} | ${counts[status]} |`),
        '',
        '## Readiness Funnel',
        '',
        '| Check | Passed |',
        '|---|---:|',
        `| PagerDuty team exists | ${teamExists}/${rows.length} |`,
        `| Complete tag applied | ${complete}/${rows.length} |`,
        `| Service configured | ${service}/${rows.length} |`,
        `| Level 1 on-call active | ${level1}/${rows.length} |`,
        `| Both notifications sent | ${bothSent}/${rows.length} |`,
        `| Both notifications handled | ${bothHandled}/${rows.length} |`,
        '',
        '## Since Previous Report',
        '',
        priorSnapshot
            ? `- Newly ready: ${newlyReady.length}`
            : '- No prior snapshot is available; this is the baseline report.',
        priorSnapshot ? `- New blockers: ${newBlockers.length}` : '',
        priorSnapshot ? `- Resolved blockers: ${resolvedBlockers.length}` : '',
        '',
        '## Priority Actions',
        '',
        '| Priority | Team | Issue | Required Action |',
        '|---|---|---|---|',
        ...actions.map((row) =>
            `| ${priorityFor(row.status)} | ${escapeMarkdown(row.name)} | ` +
            `${escapeMarkdown(row.issue)} | ${escapeMarkdown(row.requiredAction)} |`
        ),
        '',
        actions.length < rows.filter((row) => !['Ready', 'In Progress'].includes(row.status)).length
            ? `Additional teams requiring action: ${rows.filter((row) => !['Ready', 'In Progress'].includes(row.status)).length - actions.length}`
            : '',
        '',
        '## Notes',
        '',
        '- Suppression rules and pending invitations are reported by their dedicated audit scripts and are not readiness blockers in this version.',
        '- Ready requires both PagerDuty and Opsgenie migration notifications to be handled.',
        '- Team scope is defined in `config/migration-teams.json`.',
        `- Manually excluded from this report: ${excludedCount} teams.`,
        '',
    ].filter((line, index, array) => line !== '' || index === 0 || array[index - 1] !== '')

    const snapshot = {
        generatedAt: now.toISOString(),
        summary: { overall, approved: rows.length, counts },
        teams: rows.map((row) => ({
            name: row.name,
            status: row.status,
            issue: row.issue,
            tags: row.tags,
            hasService: row.hasService,
            hasPolicy: row.hasPolicy,
            hasLevel1: row.hasLevel1,
            hasPDNotification: row.hasPDNotification,
            hasOpsgenieNotification: row.hasOpsgenieNotification,
            alertsHandled: row.alerts.handled,
        })),
    }

    fs.writeFileSync(reportPath, `${lines.join('\n')}\n`, 'utf8')
    fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
    return { reportPath, snapshotPath }
}

async function main() {
    console.log('Collecting migration readiness data...')
    await connect()

    try {
        const resolvedTags = await Promise.all(
            CONFIG.includePagerDutyTags.map(async (name) => ({ name, tag: await resolveTagId(name) }))
        )
        const tagIds = new Map()
        for (const { name, tag } of resolvedTags) {
            if (!tag) throw new Error(`Required migration tag not found: ${name}`)
            tagIds.set(name, await getTeamIdsByTagId(tag.id))
        }

        const [pdTeams, services, policies, onCalls, coverage] = await Promise.all([
            getAllTeams(),
            fetchAllPages('/services?include[]=teams', 'services'),
            fetchAllPages('/escalation_policies?include[]=teams', 'escalation_policies'),
            fetchAllPages('/oncalls?include[]=users&include[]=escalation_policies', 'oncalls'),
            getCoverageStatus(),
        ])
        const pdByName = new Map(pdTeams.map((team) => [team.name.toLowerCase(), team]))
        const tagsByTeamId = new Map()
        for (const [tagName, ids] of tagIds) {
            for (const id of ids) {
                if (!tagsByTeamId.has(id)) tagsByTeamId.set(id, new Set())
                tagsByTeamId.get(id).add(tagName)
            }
        }
        const serviceTeamIds = new Set(services.flatMap((service) => (service.teams || []).map((team) => team.id)))
        const policyTeamIds = new Set(policies.flatMap((policy) => (policy.teams || []).map((team) => team.id)))
        const policyTeamIdsByPolicy = new Map(
            policies.map((policy) => [policy.id, (policy.teams || []).map((team) => team.id)])
        )
        const level1TeamIds = new Set()
        for (const onCall of onCalls) {
            if (onCall.escalation_level !== 1) continue
            for (const teamId of policyTeamIdsByPolicy.get(onCall.escalation_policy.id) || []) {
                level1TeamIds.add(teamId)
            }
        }

        const excludedNames = new Set(
            (CONFIG.excludedTeams || []).map((name) => name.toLowerCase())
        )
        const scopeNames = new Set([
            ...CONFIG.additionalTeams,
            ...pdTeams.filter((team) => tagsByTeamId.has(team.id)).map((team) => team.name),
        ].filter((name) => !excludedNames.has(name.toLowerCase())))
        const baseRows = [...scopeNames].map((name) => {
            const pdTeam = pdByName.get(name.toLowerCase())
            const teamCoverage = pdTeam ? coverage.get(pdTeam.id) : null
            return {
                name,
                pdTeam,
                tags: pdTeam ? [...(tagsByTeamId.get(pdTeam.id) || [])] : [],
                hasService: Boolean(pdTeam && serviceTeamIds.has(pdTeam.id)),
                hasPolicy: Boolean(pdTeam && policyTeamIds.has(pdTeam.id)),
                hasLevel1: Boolean(pdTeam && level1TeamIds.has(pdTeam.id)),
                hasPDNotification: Boolean(teamCoverage?.hasPD),
                hasOpsgenieNotification: Boolean(teamCoverage?.hasOpsGenie),
                coverage: teamCoverage,
            }
        })
        const alertStates = await mapWithConcurrency(
            baseRows.filter((row) => row.coverage?.hasPD && row.coverage?.hasOpsGenie),
            ALERT_CONCURRENCY,
            async (row) => ({ name: row.name, alerts: await getAlertHandling(row.coverage) })
        )
        const alertsByName = new Map(alertStates.map((item) => [item.name, item.alerts]))
        const rows = baseRows.map((row) => {
            const alerts = alertsByName.get(row.name) || {
                pd: row.hasPDNotification ? 'Not checked' : 'Missing',
                og: row.hasOpsgenieNotification ? 'Not checked' : 'Missing',
                handled: false,
                unknown: false,
            }
            const classification = classifyTeam({ ...row, alerts })
            return {
                ...row,
                alerts,
                ...classification,
                requiredAction: requiredAction(classification.status, classification.issue),
            }
        })

        const dailyDir = path.join(__dirname, 'reports', 'daily')
        const { reportPath, snapshotPath } = writeOutputs(
            rows,
            findPreviousSnapshot(dailyDir, dateStamp(new Date())),
            excludedNames.size
        )
        console.log(`Report written to ${reportPath}`)
        console.log(`Snapshot written to ${snapshotPath}`)
    } finally {
        await disconnect()
    }
}

main().catch((err) => {
    console.error(`Fatal error: ${err.message}`)
    process.exit(1)
})
