'use strict'

require('dotenv').config()

const fs = require('fs')
const os = require('os')
const path = require('path')

const { connect, disconnect, getCoverageStatus } = require('./lib/db')
const { fetchAllPages, getAllTeams, resolveTagId, getTeamIdsByTagId, pdGet } = require('./lib/pagerduty')
const { ogGet } = require('./lib/opsgenie')

const CONFIG = require('./config/migration-teams.json')
const OPSGENIE_FALLBACK_INTERVAL_MS = 700

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

function escapeMarkdown(value) {
    return String(value ?? '')
        .replace(/\|/g, '\\|')
        .replace(/\r?\n/g, ' ')
}

function parseAlertmanagerTeams(configPath) {
    if (!configPath) return { teams: new Set(), lastUpdated: null }

    const resolved = configPath.startsWith('~')
        ? path.join(os.homedir(), configPath.slice(1))
        : configPath

    try {
        const content = fs.readFileSync(resolved, 'utf8')
        const lastUpdated = fs.statSync(resolved).mtime
        const match = content.match(/pagerduty_event_orchestrations\s*=\s*\[([\s\S]*?)\]/)
        if (!match) {
            console.warn('  [WARN] pagerduty_event_orchestrations block not found in alertmanager config')
            return { teams: new Set(), lastUpdated }
        }
        const names = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1].toLowerCase())
        return { teams: new Set(names), lastUpdated }
    } catch (err) {
        console.warn(`  [WARN] Could not read alertmanager config: ${err.message}`)
        return { teams: new Set(), lastUpdated: null }
    }
}

function dateStamp(date) {
    return date.toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' })
}

// Phase 1 — resolve via async request ID (fast, no throttle needed).
// Returns the Opsgenie alert object, or null if the request ID has expired (404).
async function resolveViaRequestId(requestId) {
    try {
        const req = await ogGet(`/v2/alerts/requests/${encodeURIComponent(requestId)}`)
        const alertId = req.data?.alertId
        if (!alertId) return null
        const res = await ogGet(`/v2/alerts/${encodeURIComponent(alertId)}?identifierType=id`)
        return res.data ?? null
    } catch (_) {
        return null
    }
}

// Phase 2 — message search fallback for expired request IDs.
// Called sequentially with a throttle delay between each invocation.
async function resolveViaMessageSearch(teamName) {
    const q = encodeURIComponent(`message:"Migration Complete: ${teamName}"`)
    const res = await ogGet(`/v2/alerts?query=${q}&limit=1&sort=createdAt&order=desc`)
    return res.data?.[0] ?? null
}

function buildAlertResult(pdResponse, ogAlert) {
    const pdStatus = pdResponse.incident.status
    const pdHandled = ['acknowledged', 'resolved'].includes(pdStatus)
    const ogStatus = ogAlert.status === 'closed'
        ? 'Closed'
        : ogAlert.acknowledged
          ? 'Acknowledged'
          : 'Open'
    const ogHandled = ogAlert.acknowledged || ogAlert.status === 'closed'
    return {
        pd: pdStatus.charAt(0).toUpperCase() + pdStatus.slice(1),
        og: ogStatus,
        handled: pdHandled || ogHandled,
        pdHandled,
        ogHandled,
        unknown: false,
    }
}

const FAILED = { pd: 'Lookup failed', og: 'Lookup failed', handled: false, unknown: true }

// Two-phase batch alert resolution.
// Phase 1 runs all PD + OG request-ID lookups concurrently.
// Phase 2 runs message-search fallbacks for expired request IDs sequentially at 700 ms intervals.
async function getAlertHandlingBatch(candidates) {
    if (candidates.length === 0) return new Map()

    // Phase 1: concurrent PD + OG request-ID lookups
    const phase1 = await Promise.all(
        candidates.map(async (row) => {
            try {
                const [pdResponse, ogAlert] = await Promise.all([
                    pdGet(`/incidents/${row.coverage.incidentId}`),
                    resolveViaRequestId(row.coverage.opsgenieRequestId),
                ])
                return { name: row.name, pdResponse, ogAlert, needsFallback: ogAlert === null }
            } catch (_) {
                return { name: row.name, pdResponse: null, ogAlert: null, needsFallback: false, failed: true }
            }
        })
    )

    const results = new Map()
    const needsFallback = []

    for (const item of phase1) {
        if (item.failed) {
            results.set(item.name, FAILED)
        } else if (!item.needsFallback) {
            results.set(item.name, buildAlertResult(item.pdResponse, item.ogAlert))
        } else {
            needsFallback.push(item)
        }
    }

    // Phase 2: sequential message-search fallbacks with throttle
    console.log(`  Phase 2: ${needsFallback.length} team(s) need Opsgenie message-search fallback...`)
    for (let i = 0; i < needsFallback.length; i++) {
        const item = needsFallback[i]
        try {
            const teamName = candidates.find((c) => c.name === item.name)?.coverage?.teamName || item.name
            const ogAlert = await resolveViaMessageSearch(teamName)
            results.set(item.name, ogAlert
                ? buildAlertResult(item.pdResponse, ogAlert)
                : FAILED
            )
        } catch (_) {
            results.set(item.name, FAILED)
        }
        if (i < needsFallback.length - 1) await sleep(OPSGENIE_FALLBACK_INTERVAL_MS)
    }

    return results
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
    if (!team.hasPolicy) return { status: 'Attention', issue: 'Escalation policy needs to be configured' }
    if (!team.hasLevel1) return { status: 'Attention', issue: 'Level 1 on-call needs to be configured' }
    if (team.hasService && !team.hasPDNotification) return { status: 'In Progress', issue: 'PagerDuty notification has not been triggered' }
    if (!team.hasOpsgenieNotification) return { status: 'In Progress', issue: 'Opsgenie notification has not been triggered' }
    if (team.alerts.unknown) return { status: 'Unknown', issue: 'Alert status lookup failed' }
    if (!team.alerts.handled) return { status: 'Attention', issue: 'Opsgenie notification requires acknowledgement' }
    return { status: 'Ready', issue: '' }
}

function writeOutputs(rows, priorSnapshot, excludedCount, invites, alertmanagerTeams, alertmanagerLastUpdated) {
    const now = new Date()
    const today = dateStamp(now)
    const dailyDir = path.join(__dirname, 'reports', 'daily')
    const actionsDir = path.join(dailyDir, 'actions')
    const reportPath = path.join(dailyDir, `${today}-migration-summary.md`)
    const snapshotPath = path.join(dailyDir, `${today}-migration-snapshot.json`)
    const actionsPath = path.join(actionsDir, `${today}-migration-actions.md`)
    fs.mkdirSync(dailyDir, { recursive: true })
    fs.mkdirSync(actionsDir, { recursive: true })

    const statuses = ['Ready', 'Attention', 'In Progress', 'Not Started', 'Unknown']
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
    const ogHandledCount = rows.filter((row) => row.alerts.ogHandled).length
    const pdHandled = rows.filter((row) => row.alerts.pdHandled).length
    const alertmanagerCount = rows.filter((row) => alertmanagerTeams.has(row.name.toLowerCase())).length
    const readyPercentage = ((counts.Ready / rows.length) * 100).toFixed(1)
    const overall = counts.Ready / rows.length >= 0.95
        ? 'Green'
        : counts.Ready / rows.length >= 0.8
          ? 'Amber'
          : 'Red'

    const actionableRows = rows.filter((row) => !['Ready', 'In Progress'].includes(row.status))
    const byIssue = new Map()
    for (const row of actionableRows) {
        if (!byIssue.has(row.issue)) byIssue.set(row.issue, [])
        byIssue.get(row.issue).push(row.name)
    }
    const issueSummary = [...byIssue.entries()]
        .map(([issue, teams]) => ({ issue, teams: teams.sort() }))
        .sort((a, b) => b.teams.length - a.teams.length)

    const readyMissingAlertmanager = rows
        .filter((row) => row.status === 'Ready' && !alertmanagerTeams.has(row.name.toLowerCase()))
        .map((row) => row.name)
        .sort()

    const generatedAt = now.toLocaleString('en-CA', {
        timeZone: 'Europe/Amsterdam',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    }).replace(',', '') + ' AMS'
    const lines = [
        '# Opsgenie to PagerDuty Migration',
        '',
        `**Daily Summary - ${today}**`,
        '',
        `**Approved scope:** ${rows.length} teams — union of PagerDuty teams tagged Complete or WIP and the curated additional team list in \`config/migration-teams.json\`, minus manually excluded teams.  `,
        `**Fully ready:** ${counts.Ready} teams (${readyPercentage}%) — teams that have passed every check in the readiness funnel and have either their PagerDuty incident or Opsgenie alert handled.  `,
        `**Data timestamp:** ${generatedAt}`,
        '',
        '## Status',
        '',
        '_Current migration status for all approved teams. A team is **Ready** when it has a PagerDuty team, escalation policy, Level 1 on-call, both notifications sent, and either the PagerDuty incident or the Opsgenie alert has been handled. **Attention** means configuration is complete but handling is still required. **In Progress** means the team is tagged WIP or notifications have not yet been triggered. **Not Started** means no PagerDuty team has been found for this approved team._',
        '',
        '| Status | Teams |',
        '|---|---:|',
        ...statuses.map((status) => `| ${status} | ${counts[status]} |`),
        '',
        '## Readiness Funnel',
        '',
        '_Sequential migration checklist across the approved scope. Each row shows how many teams have passed that step. The denominator changes for notification and handling rows since those only apply to teams that have had both notifications sent._',
        '',
        '| Check | Passed |',
        '|---|---:|',
        `| PagerDuty team exists | ${teamExists}/${rows.length} |`,
        `| Complete tag applied | ${complete}/${rows.length} |`,
        `| Service configured | ${service}/${rows.length} |`,
        `| Level 1 on-call active | ${level1}/${rows.length} |`,
        `| Both notifications sent | ${bothSent}/${rows.length} |`,
        `| Opsgenie acknowledged or closed | ${ogHandledCount}/${bothSent} |`,
        `| PagerDuty notification acknowledged or resolved | ${pdHandled}/${bothSent} |`,
        `| Either channel handled (Ready gate) | ${bothHandled}/${bothSent} |`,
        `| Alertmanager enabled (config updated: ${alertmanagerLastUpdated ? alertmanagerLastUpdated.toLocaleString('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '') + ' AMS' : 'unknown'}) | ${alertmanagerCount}/${rows.length} |`,
        '',
        '## Pending Invitations',
        '',
        '_Users who have been sent a PagerDuty invitation but have not yet logged in. Informational only — does not affect readiness._',
        '',
        '| Status | Count | Percentage |',
        '|---|---:|---:|',
        `| Accepted (active) | ${invites.accepted} | ${((invites.accepted / invites.total) * 100).toFixed(1)}% |`,
        `| Pending (not accepted) | ${invites.pending} | ${((invites.pending / invites.total) * 100).toFixed(1)}% |`,
        `| **Total** | **${invites.total}** | **100%** |`,
        '',
        '## Since Previous Report',
        '',
        '_Day-over-day changes compared to the previous daily snapshot._',
        '',
        priorSnapshot
            ? `- Newly ready: ${newlyReady.length}`
            : '- No prior snapshot is available; this is the baseline report.',
        priorSnapshot ? `- New blockers: ${newBlockers.length}` : '',
        priorSnapshot ? `- Resolved blockers: ${resolvedBlockers.length}` : '',
        '',
        '## Actions Required',
        '',
        '_Teams that still need migration work, grouped by the specific action required. Ready and In Progress teams are excluded. See the linked detail file for the full team list per action._',
        '',
        '| Issue | Teams |',
        '|---|---:|',
        ...issueSummary.map(({ issue, teams }) => `| ${escapeMarkdown(issue)} | ${teams.length} |`),
        `| **Total** | **${actionableRows.length}** |`,
        '',
        '_Post-readiness — these teams are Ready but have a remaining configuration step:_',
        '',
        '| Issue | Teams |',
        '|---|---:|',
        `| Alertmanager not yet enabled (Ready teams) | ${readyMissingAlertmanager.length} |`,
        '',
        `_Full team breakdown: [${today}-migration-actions.md](./actions/${today}-migration-actions.md)_`,
        '',
    ].filter((line, index, array) => line !== '' || index === 0 || array[index - 1] !== '')

    const actionsLines = [
        '# Migration Actions Detail',
        '',
        `_Generated: ${generatedAt}_`,
        '',
        ...issueSummary.flatMap(({ issue, teams }) => [
            `## ${issue} (${teams.length})`,
            '',
            ...teams.map((name) => `- ${name}`),
            '',
        ]),
        `## Alertmanager not yet enabled — Ready teams (${readyMissingAlertmanager.length})`,
        '',
        '_These teams have completed the migration but still need to be added to `pagerduty_event_orchestrations` in terragrunt.hcl._',
        '',
        ...readyMissingAlertmanager.map((name) => `- ${name}`),
        '',
    ]

    const snapshot = {
        generatedAt: now.toISOString(),
        summary: { overall, approved: rows.length, counts, invites },
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
    fs.writeFileSync(actionsPath, `${actionsLines.join('\n')}\n`, 'utf8')
    fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
    return { reportPath, actionsPath, snapshotPath }
}

async function main() {
    console.log('Collecting migration readiness data...')
    const { teams: alertmanagerTeams, lastUpdated: alertmanagerLastUpdated } = parseAlertmanagerTeams(CONFIG.alertmanagerConfigPath)
    console.log(`  Alertmanager teams loaded: ${alertmanagerTeams.size}`)
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

        const [pdTeams, services, policies, onCalls, coverage, allUsers] = await Promise.all([
            getAllTeams(),
            fetchAllPages('/services?include[]=teams', 'services'),
            fetchAllPages('/escalation_policies?include[]=teams', 'escalation_policies'),
            fetchAllPages('/oncalls?include[]=users&include[]=escalation_policies', 'oncalls'),
            getCoverageStatus(),
            fetchAllPages('/users', 'users'),
        ])
        const pending = allUsers.filter((u) => u.invitation_sent === true).length
        const invites = { total: allUsers.length, accepted: allUsers.length - pending, pending }
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
        const candidates = baseRows.filter((row) => row.coverage?.hasPD && row.coverage?.hasOpsGenie)
        console.log(`  Phase 1: resolving ${candidates.length} alert(s) concurrently...`)
        const alertsByName = await getAlertHandlingBatch(candidates)
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
            }
        })

        const dailyDir = path.join(__dirname, 'reports', 'daily')
        const { reportPath, actionsPath, snapshotPath } = writeOutputs(
            rows,
            findPreviousSnapshot(dailyDir, dateStamp(new Date())),
            excludedNames.size,
            invites,
            alertmanagerTeams,
            alertmanagerLastUpdated
        )
        console.log(`Report written to ${reportPath}`)
        console.log(`Actions written to ${actionsPath}`)
        console.log(`Snapshot written to ${snapshotPath}`)
    } finally {
        await disconnect()
    }
}

main().catch((err) => {
    console.error(`Fatal error: ${err.message}`)
    process.exit(1)
})
