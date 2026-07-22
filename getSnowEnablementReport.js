'use strict'

require('dotenv').config()

const fs = require('fs')
const os = require('os')
const path = require('path')

const { getAllTeams, fetchAllPages, pdGet } = require('./lib/pagerduty')
const CONFIG = require('./config/migration-teams.json')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dateStamp(date) {
    return date.toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' })
}

function generatedAtStamp(date) {
    return date.toLocaleString('en-CA', {
        timeZone: 'Europe/Amsterdam',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    }).replace(',', '') + ' AMS'
}

/**
 * Parse opsgenie_paging_suppressions from terragrunt.hcl.
 * Returns a Map<teamNameLower, boolean> — true = suppression enabled.
 */
function parseSuppressions(configPath) {
    if (!configPath) return new Map()

    const resolved = configPath.startsWith('~')
        ? path.join(os.homedir(), configPath.slice(1))
        : configPath

    try {
        const content = fs.readFileSync(resolved, 'utf8')
        const match = content.match(/opsgenie_paging_suppressions\s*=\s*\{([\s\S]*?)\n  \}/)
        if (!match) {
            console.warn('  [WARN] opsgenie_paging_suppressions block not found in terragrunt.hcl')
            return new Map()
        }
        const entries = [...match[1].matchAll(/\"([^\"]+)\"\s*=\s*\{\s*enabled\s*=\s*(true|false)\s*\}/g)]
        return new Map(entries.map(e => [e[1].toLowerCase(), e[2] === 'true']))
    } catch (err) {
        console.warn(`  [WARN] Could not read terragrunt.hcl: ${err.message}`)
        return new Map()
    }
}

/**
 * Fetch all active prod SNOW webhooks and return a Set of PD team names (lowercased)
 * that have one scoped to one of their services.
 */
async function getWebhookTeamNames() {
    const webhooks = await fetchAllPages('/webhook_subscriptions', 'webhook_subscriptions')
    const activeSnow = webhooks.filter(w =>
        w.active &&
        !w.delivery_method?.temporarily_disabled &&
        w.delivery_method?.url?.includes('aholddelhaize.service-now.com') &&
        w.filter?.type === 'service_reference'
    )

    console.log(`  Active prod SNOW webhooks found: ${activeSnow.length}`)

    const teamNameSets = await Promise.all(
        activeSnow.map(w =>
            pdGet(`/services/${w.filter.id}?include[]=teams`).then(r =>
                (r.service.teams || []).map(t => t.summary.toLowerCase())
            )
        )
    )
    return new Set(teamNameSets.flat())
}

// ---------------------------------------------------------------------------
// Report writer
// ---------------------------------------------------------------------------

function writeReport(teams, suppressions, webhookTeams) {
    const now = new Date()
    const today = dateStamp(now)
    const generatedAt = generatedAtStamp(now)

    // Classify every PD team
    const fullyEnabled    = []
    const webhookMissing  = []   // suppression true, no webhook
    const suppressionMissing = [] // webhook exists, suppression false/missing
    const notStarted      = []   // in terraform, neither enabled
    const notInTerraform  = []   // no entry in suppression block at all

    for (const team of teams) {
        const lower = team.name.toLowerCase()
        const hasWebhook = webhookTeams.has(lower)
        const inTerraform = suppressions.has(lower)
        const hasSuppression = inTerraform && suppressions.get(lower)

        if (!inTerraform) {
            notInTerraform.push(team.name)
        } else if (hasWebhook && hasSuppression) {
            fullyEnabled.push(team.name)
        } else if (!hasWebhook && hasSuppression) {
            webhookMissing.push(team.name)
        } else if (hasWebhook && !hasSuppression) {
            suppressionMissing.push(team.name)
        } else {
            notStarted.push(team.name)
        }
    }

    // Sort all lists alphabetically
    ;[fullyEnabled, webhookMissing, suppressionMissing, notStarted, notInTerraform]
        .forEach(list => list.sort())

    const total = teams.length

    // ---------------------------------------------------------------------------
    // Build markdown
    // ---------------------------------------------------------------------------

    const tick = '✔'
    const cross = '✗'

    const lines = [
        '# ServiceNow Enablement Report',
        '',
        `**Generated:** ${generatedAt}  `,
        `**Source:** PagerDuty team list vs \`opsgenie_paging_suppressions\` in \`terragrunt.hcl\` + active SNOW webhooks`,
        '',
        '---',
        '',
        '## Summary',
        '',
        '| Status | Teams |',
        '|---|---:|',
        `| Fully enabled (webhook + suppression) | ${fullyEnabled.length} |`,
        `| Partial — webhook missing | ${webhookMissing.length} |`,
        `| Partial — suppression missing | ${suppressionMissing.length} |`,
        `| Not started | ${notStarted.length} |`,
        `| Not in Terraform | ${notInTerraform.length} |`,
        `| **Total PagerDuty teams** | **${total}** |`,
        '',
        '---',
        '',
        `## Fully Enabled (${fullyEnabled.length})`,
        '',
        '_Both the SNOW webhook and OpsGenie suppression are active for these teams._',
        '',
        '| Team | Webhook | Suppression |',
        '|---|:---:|:---:|',
        ...fullyEnabled.map(name => `| ${name} | ${tick} | ${tick} |`),
        '',
        '---',
        '',
        `## Partial — Webhook Missing (${webhookMissing.length})`,
        '',
        '_Suppression is enabled in Terraform but no active SNOW webhook exists. A webhook needs to be created in PagerDuty._',
        '',
        '| Team | Webhook | Suppression |',
        '|---|:---:|:---:|',
        ...(webhookMissing.length > 0
            ? webhookMissing.map(name => `| ${name} | ${cross} | ${tick} |`)
            : ['| — | | |']),
        '',
        '---',
        '',
        `## Partial — Suppression Missing (${suppressionMissing.length})`,
        '',
        '_An active SNOW webhook exists but suppression is not yet enabled in Terraform. Set `enabled = true` in `opsgenie_paging_suppressions`._',
        '',
        '| Team | Webhook | Suppression |',
        '|---|:---:|:---:|',
        ...(suppressionMissing.length > 0
            ? suppressionMissing.map(name => `| ${name} | ${tick} | ${cross} |`)
            : ['| — | | |']),
        '',
        '---',
        '',
        `## Not Started (${notStarted.length})`,
        '',
        '_In the Terraform suppression block but neither the webhook nor the suppression has been enabled._',
        '',
        '| Team |',
        '|---|',
        ...notStarted.map(name => `| ${name} |`),
        '',
        '---',
        '',
        `## Not in Terraform (${notInTerraform.length})`,
        '',
        '_These PagerDuty teams have no entry in `opsgenie_paging_suppressions` in `terragrunt.hcl`. They cannot have suppression configured until an entry is added._',
        '',
        '| Team |',
        '|---|',
        ...notInTerraform.map(name => `| ${name} |`),
        '',
    ]

    const outDir = path.join(__dirname, 'reports', 'snow')
    fs.mkdirSync(outDir, { recursive: true })
    const outPath = path.join(outDir, `${today}-snow-enablement.md`)
    fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf8')
    return outPath
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    console.log('Collecting ServiceNow enablement data...')

    const suppressions = parseSuppressions(CONFIG.alertmanagerConfigPath)
    console.log(`  Terraform suppression entries loaded: ${suppressions.size}`)
    console.log(`  Entries with enabled=true: ${[...suppressions.values()].filter(Boolean).length}`)

    const [pdTeams, webhookTeams] = await Promise.all([
        getAllTeams(),
        getWebhookTeamNames(),
    ])

    console.log(`  PagerDuty teams: ${pdTeams.length}`)
    console.log(`  Teams with active SNOW webhook: ${webhookTeams.size}`)

    const outPath = writeReport(pdTeams, suppressions, webhookTeams)
    console.log(`\nReport written to ${outPath}`)
}

main().catch(err => {
    console.error(`Fatal error: ${err.message}`)
    process.exit(1)
})
