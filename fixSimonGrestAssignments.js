'use strict'

/**
 * Temporary remediation script.
 *
 * Simon Grest (P25TUMU) acknowledged PagerDuty migration incidents for teams
 * he does not belong to. This script reassigns those incidents to the correct
 * Level 1 on-call person(s) for each affected team.
 *
 * Usage:
 *   node fixSimonGrestAssignments.js            # dry-run (no changes)
 *   node fixSimonGrestAssignments.js --execute  # apply reassignments
 */

require('dotenv').config()

const { connect, disconnect, getCoverageStatus } = require('./lib/db')
const { pdGet } = require('./lib/pagerduty')

const SIMON_GREST_ID = 'P25TUMU'
const dryRun = !process.argv.includes('--execute')

async function getIncidentDetails(incidentId) {
    try {
        const r = await pdGet(`/incidents/${incidentId}?include[]=assignees&include[]=acknowledgers`)
        return r.incident
    } catch (_) {
        return null
    }
}

async function getLevel1OnCall(policyId) {
    try {
        const r = await pdGet(`/oncalls?escalation_policy_ids[]=${policyId}&include[]=users`)
        return (r.oncalls || [])
            .filter((oc) => oc.escalation_level === 1)
            .map((oc) => ({ id: oc.user.id, name: oc.user.summary }))
    } catch (_) {
        return []
    }
}

async function reassignIncident(incidentId, assignees) {
    const url = `https://api.pagerduty.com/incidents/${incidentId}`
    const response = await fetch(url, {
        method: 'PUT',
        headers: {
            Accept: 'application/vnd.pagerduty+json;version=2',
            Authorization: `Token token=${process.env.PAGERDUTY_API_KEY}`,
            'Content-Type': 'application/json',
            From: process.env.PAGERDUTY_FROM_EMAIL,
        },
        body: JSON.stringify({
            incident: {
                type: 'incident',
                assignments: assignees.map((a) => ({
                    assignee: { id: a.id, type: 'user_reference' },
                })),
            },
        }),
    })
    if (!response.ok) {
        const text = await response.text()
        throw new Error(`PUT /incidents/${incidentId} failed ${response.status}: ${text}`)
    }
    return response.json()
}

async function main() {
    console.log(`Mode: ${dryRun ? 'DRY-RUN (no changes will be made)' : 'EXECUTE'}`)
    console.log('Loading notification records...\n')

    await connect()

    try {
        const coverage = await getCoverageStatus()
        const applications = [...coverage.values()].filter((a) => a.incidentId)

        // Phase 1 — fetch all incident details concurrently
        console.log(`Fetching ${applications.length} incidents concurrently...`)
        const incidentResults = await Promise.all(
            applications.map(async (app) => ({
                app,
                incident: await getIncidentDetails(app.incidentId),
            }))
        )

        // Filter to incidents involving Simon Grest
        const simonAssigned = incidentResults.filter(({ incident }) => {
            if (!incident) return false
            const assignedToSimon = (incident.assignments || []).some((a) => a.assignee?.id === SIMON_GREST_ID)
            const acknowledgedBySimon = (incident.acknowledgements || []).some((a) => a.acknowledger?.id === SIMON_GREST_ID)
            return assignedToSimon || acknowledgedBySimon
        })

        console.log(`Found ${simonAssigned.length} incidents involving Simon Grest. Resolving correct on-call...\n`)

        // Phase 2 — look up correct on-call for each affected incident
        const affected = []
        const skipped = []

        for (const { app, incident } of simonAssigned) {
            const policyId = incident.escalation_policy?.id
            if (!policyId) {
                skipped.push({ team: app.teamName, reason: 'No escalation policy found' })
                continue
            }

            const level1 = await getLevel1OnCall(policyId)
            const correctAssignees = level1.filter((u) => u.id !== SIMON_GREST_ID)

            if (correctAssignees.length === 0) {
                skipped.push({
                    team: app.teamName,
                    incidentId: app.incidentId,
                    reason: 'No alternative Level 1 on-call found',
                })
                continue
            }

            affected.push({
                team: app.teamName,
                incidentId: app.incidentId,
                status: incident.status,
                correctAssignees,
            })
        }

        // Print summary table
        const col = (s, n) => String(s ?? '').padEnd(n).slice(0, n)
        console.log(
            col('Team', 45) +
            col('Status', 15) +
            col('New Assignee(s)', 50) +
            'Action'
        )
        console.log('─'.repeat(130))

        for (const item of affected) {
            console.log(
                col(item.team, 45) +
                col(item.status, 15) +
                col(item.correctAssignees.map((a) => a.name).join(', '), 50) +
                (dryRun ? 'Will reassign' : 'Reassigning...')
            )
        }
        for (const item of skipped) {
            console.log(
                col(item.team, 45) +
                col('—', 15) +
                col('—', 50) +
                `Skip — ${item.reason}`
            )
        }

        console.log(`\nAffected: ${affected.length}   Skipped: ${skipped.length}`)

        if (dryRun) {
            console.log('\nDry-run complete. Run with --execute to apply changes.')
            return
        }

        // Execute reassignments
        console.log('\nApplying reassignments...\n')
        let succeeded = 0
        let failed = 0

        for (const item of affected) {
            try {
                await reassignIncident(item.incidentId, item.correctAssignees)
                console.log(`  [OK]     ${item.team} → ${item.correctAssignees.map((a) => a.name).join(', ')}`)
                succeeded++
            } catch (err) {
                console.error(`  [FAILED] ${item.team} — ${err.message}`)
                failed++
            }
        }

        console.log(`\nDone. Reassigned: ${succeeded}   Failed: ${failed}   Skipped: ${skipped.length}`)

    } finally {
        await disconnect()
    }
}

main().catch((err) => {
    console.error(`Fatal error: ${err.message}`)
    process.exit(1)
})
