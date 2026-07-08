'use strict'

require('dotenv').config()

const fs = require('fs')
const path = require('path')

const { fetchAllPages } = require('./lib/pagerduty')

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

async function getAllUsers() {
    return fetchAllPages('/users', 'users')
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------

function generateMarkdown(allUsers, pending) {
    const active = allUsers.length - pending.length
    const total = allUsers.length
    const activePct = ((active / total) * 100).toFixed(1)
    const pendingPct = ((pending.length / total) * 100).toFixed(1)

    const sorted = [...pending].sort((a, b) => {
        const ta = a.teams && a.teams.length ? a.teams[0].summary : 'ZZZ'
        const tb = b.teams && b.teams.length ? b.teams[0].summary : 'ZZZ'
        return ta.localeCompare(tb) || a.name.localeCompare(b.name)
    })

    const lines = []

    lines.push('# PagerDuty — Pending Invites')
    lines.push('')
    lines.push('## Summary')
    lines.push('')
    lines.push('| Status | Count | Percentage |')
    lines.push('|--------|-------|------------|')
    lines.push(`| Accepted (active) | ${active} | ${activePct}% |`)
    lines.push(
        `| Pending (not accepted) | ${pending.length} | ${pendingPct}% |`
    )
    lines.push(`| **Total** | **${total}** | **100%** |`)
    lines.push('')
    lines.push(
        `> **${pending.length} users** have been sent an invitation and have not yet logged in.`
    )
    lines.push('')
    lines.push('| # | Name | Teams |')
    lines.push('|---|------|-------|')

    sorted.forEach((u, i) => {
        const teams =
            u.teams && u.teams.length
                ? u.teams.map((t) => t.summary).join(', ')
                : 'N/A'
        lines.push(`| ${i + 1} | ${u.name} | ${teams} |`)
    })

    return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    console.log('Fetching all PagerDuty users...\n')

    const allUsers = await getAllUsers()
    const pending = allUsers.filter((u) => u.invitation_sent === true)

    console.log(`Total users:          ${allUsers.length}`)
    console.log(`Accepted (active):    ${allUsers.length - pending.length}`)
    console.log(`Pending (not logged): ${pending.length}\n`)

    if (pending.length === 0) {
        console.log('No pending invitations found.')
        return
    }

    const reportsDir = path.join(__dirname, 'reports')
    fs.mkdirSync(reportsDir, { recursive: true })
    const outputPath = path.join(reportsDir, 'pendingInvites.md')
    fs.writeFileSync(outputPath, generateMarkdown(allUsers, pending))
    console.log(`Report written to ${outputPath}`)
}

main().catch((err) => {
    console.error('Fatal error:', err.message)
    process.exit(1)
})
