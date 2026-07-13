'use strict'

require('dotenv').config()

const fs = require('fs')
const path = require('path')

const { fetchAllPages, getAllTeams } = require('./lib/pagerduty')

function escapeMarkdown(value) {
    return String(value ?? '')
        .replace(/\|/g, '\\|')
        .replace(/\r?\n/g, ' ')
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
        `${timestamp}-pagerduty-on-call-report.md`
    )

    fs.mkdirSync(reportsDir, { recursive: true })

    const counts = {
        teams: new Set(rows.map((row) => row.team)).size,
        active: rows.filter((row) => row.state === 'Active').length,
        noPolicy: rows.filter((row) => row.state === 'No escalation policy').length,
        noOnCall: rows.filter((row) => row.state === 'No active on-call').length,
    }

    const lines = [
        '# PagerDuty On-Call by Team',
        '',
        `_Generated: ${generatedAt}_`,
        '',
        '## Summary',
        '',
        '| Metric | Count |',
        '|---|---:|',
        `| Teams | ${counts.teams} |`,
        `| Active escalation levels | ${counts.active} |`,
        `| Teams without an escalation policy | ${counts.noPolicy} |`,
        `| Escalation policies without an active on-call | ${counts.noOnCall} |`,
        '',
        '## Teams',
        '',
        '| Team | Escalation Policy | Level | Schedule | State | Current On-Call |',
        '|---|---|---:|---|---|---|',
        ...rows.map(
            (row) =>
                `| ${escapeMarkdown(row.team)} | ${escapeMarkdown(row.policy)} | ` +
                `${escapeMarkdown(row.level)} | ${escapeMarkdown(row.schedule)} | ` +
                `${row.state} | ${escapeMarkdown(row.users || '—')} |`
        ),
        '',
    ]

    fs.writeFileSync(reportPath, lines.join('\n'), 'utf8')
    return reportPath
}

async function main() {
    console.log('Fetching PagerDuty teams, escalation policies, and on-calls...')

    const [teams, policies, onCalls] = await Promise.all([
        getAllTeams(),
        fetchAllPages('/escalation_policies?include[]=teams', 'escalation_policies'),
        fetchAllPages(
            '/oncalls?include[]=users&include[]=schedules&include[]=escalation_policies',
            'oncalls'
        ),
    ])

    const policiesByTeam = new Map()
    for (const policy of policies) {
        for (const team of policy.teams || []) {
            if (!policiesByTeam.has(team.id)) policiesByTeam.set(team.id, [])
            policiesByTeam.get(team.id).push(policy)
        }
    }

    const onCallsByPolicy = new Map()
    for (const onCall of onCalls) {
        const policyId = onCall.escalation_policy.id
        if (!onCallsByPolicy.has(policyId)) onCallsByPolicy.set(policyId, [])
        onCallsByPolicy.get(policyId).push(onCall)
    }

    const rows = []
    for (const team of teams.sort((a, b) => a.name.localeCompare(b.name))) {
        const teamPolicies = policiesByTeam.get(team.id) || []
        if (teamPolicies.length === 0) {
            rows.push({
                team: team.name,
                policy: '—',
                level: '—',
                schedule: '—',
                state: 'No escalation policy',
                users: '',
            })
            continue
        }

        for (const policy of teamPolicies.sort((a, b) => a.name.localeCompare(b.name))) {
            const policyOnCalls = onCallsByPolicy.get(policy.id) || []
            if (policyOnCalls.length === 0) {
                rows.push({
                    team: team.name,
                    policy: policy.name,
                    level: '—',
                    schedule: '—',
                    state: 'No active on-call',
                    users: '',
                })
                continue
            }

            const grouped = new Map()
            for (const onCall of policyOnCalls) {
                const level = onCall.escalation_level
                const schedule = onCall.schedule?.summary || 'Direct user'
                const key = `${level}\0${schedule}`
                if (!grouped.has(key)) {
                    grouped.set(key, { level, schedule, users: new Set() })
                }
                grouped.get(key).users.add(
                    onCall.user.email || onCall.user.summary || onCall.user.name
                )
            }

            for (const group of [...grouped.values()].sort(
                (a, b) => a.level - b.level || a.schedule.localeCompare(b.schedule)
            )) {
                rows.push({
                    team: team.name,
                    policy: policy.name,
                    level: group.level,
                    schedule: group.schedule,
                    state: 'Active',
                    users: [...group.users].sort().join(', '),
                })
            }
        }
    }

    const reportPath = writeReport(rows)
    console.log(
        `Checked ${teams.length} teams, ${policies.length} escalation policies, and ${onCalls.length} on-call entries.`
    )
    console.log(`Report written to ${reportPath}`)
}

main().catch((err) => {
    console.error('Fatal error:', err.message)
    process.exit(1)
})
