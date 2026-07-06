'use strict';

require('dotenv').config();

const fs   = require('fs');
const path = require('path');

const API_KEY = process.env.PAGERDUTY_API_KEY;
const BASE_URL = 'https://api.pagerduty.com';

if (!API_KEY) {
  console.error('Error: PAGERDUTY_API_KEY is not set.');
  console.error('Set it in the .env file or export it as an environment variable:');
  console.error('  export PAGERDUTY_API_KEY=your_api_key_here');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function pdGet(path) {
  const url = `${BASE_URL}${path}`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.pagerduty+json;version=2',
      Authorization: `Token token=${API_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  if (response.status === 404) return null;

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`PagerDuty API error ${response.status} on ${path}: ${body}`);
  }

  return response.json();
}

async function fetchAllPages(basePath, resultKey, limit = 100) {
  const results = [];
  let offset = 0;
  let more = true;
  const sep = basePath.includes('?') ? '&' : '?';

  while (more) {
    const data = await pdGet(`${basePath}${sep}limit=${limit}&offset=${offset}`);
    if (!data) break;
    results.push(...(data[resultKey] || []));
    more = data.more;
    offset += limit;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Collect all suppress rules from a set of orchestration rule sets
// ---------------------------------------------------------------------------

function findSuppressedRules(sets = []) {
  const suppressed = [];
  for (const set of sets) {
    for (const rule of set.rules || []) {
      if (rule.actions && rule.actions.suppress === true) {
        suppressed.push({
          ruleSet: set.id,
          ruleId: rule.id,
          label: rule.label || '(no label)',
          conditions: rule.conditions || [],
        });
      }
    }
  }
  return suppressed;
}

// ---------------------------------------------------------------------------
// Check 1: Legacy service event rules
// ---------------------------------------------------------------------------

async function checkLegacyServiceRules(service) {
  const data = await pdGet(`/services/${service.id}/rules`);
  if (!data || !data.rules) return [];

  return data.rules
    .filter((r) => r.actions && r.actions.suppress && r.actions.suppress.value === true)
    .map((r) => ({
      ruleId: r.id,
      label: r.description || '(no label)',
      conditions: r.conditions || [],
    }));
}

// ---------------------------------------------------------------------------
// Check 2: Service orchestration rules
// ---------------------------------------------------------------------------

async function checkServiceOrchestration(service) {
  const data = await pdGet(`/event_orchestrations/services/${service.id}`);
  if (!data || !data.orchestration_path) return [];

  return findSuppressedRules(data.orchestration_path.sets);
}

// ---------------------------------------------------------------------------
// Check 3: Global orchestration rules (per orchestration)
// ---------------------------------------------------------------------------

async function checkGlobalOrchestrations() {
  const orchestrations = await fetchAllPages('/event_orchestrations', 'orchestrations');
  const findings = [];

  for (const orch of orchestrations) {
    const data = await pdGet(`/event_orchestrations/${orch.id}/global`);
    if (!data || !data.orchestration_path) continue;

    const suppressedRules = findSuppressedRules(data.orchestration_path.sets);
    if (suppressedRules.length > 0) {
      findings.push({
        orchestrationId: orch.id,
        orchestrationName: orch.name,
        suppressedRules,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------

function generateMarkdown(serviceFindings, globalFindings, generatedAt) {
  const totalServices  = serviceFindings.length;
  const totalGlobal    = globalFindings.length;
  const totalSuppressed = totalServices + totalGlobal;
  const lines = [];

  lines.push('# PagerDuty — Suppression Report');
  lines.push('');
  lines.push(`> Generated: ${generatedAt}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Type | Count |');
  lines.push('|------|-------|');
  lines.push(`| Services with suppression rules | ${totalServices} |`);
  lines.push(`| Global orchestrations with suppression rules | ${totalGlobal} |`);
  lines.push(`| **Total** | **${totalSuppressed}** |`);
  lines.push('');

  // Service-level
  lines.push('## Service-Level Suppression');
  lines.push('');

  if (serviceFindings.length === 0) {
    lines.push('_No service-level suppression rules found._');
  } else {
    lines.push('| Service | Teams | Type | Rule |');
    lines.push('|---------|-------|------|------|');
    for (const f of serviceFindings) {
      for (const r of f.legacyRules) {
        lines.push(`| ${f.serviceName} | ${f.teams} | Legacy Event Rule | ${r.label} |`);
      }
      for (const r of f.orchRules) {
        lines.push(`| ${f.serviceName} | ${f.teams} | Service Orchestration | ${r.label} |`);
      }
    }
  }

  lines.push('');

  // Global orchestrations
  lines.push('## Global Orchestration Suppression');
  lines.push('');
  lines.push('> These are expected Prometheus suppression rules, to be disabled per team as they migrate.');
  lines.push('');

  if (globalFindings.length === 0) {
    lines.push('_No global orchestration suppression rules found._');
  } else {
    lines.push('| # | Orchestration | Suppressed Rules |');
    lines.push('|---|---------------|-----------------|');
    globalFindings.forEach((f, i) => {
      const rules = f.suppressedRules.map((r) => r.label).join(', ');
      lines.push(`| ${i + 1} | ${f.orchestrationName} | ${rules} |`);
    });
  }

  lines.push('');

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Scanning for suppression rules...\n');

  // Fetch all services (include team info)
  const services = await fetchAllPages('/services?include[]=teams', 'services');
  console.log(`Found ${services.length} services. Checking each...\n`);

  const serviceFindings = [];

  for (const service of services) {
    const teams = service.teams && service.teams.length
      ? service.teams.map((t) => t.summary).join(', ')
      : 'N/A';

    // Run both checks concurrently per service
    const [legacyRules, orchRules] = await Promise.all([
      checkLegacyServiceRules(service),
      checkServiceOrchestration(service),
    ]);

    if (legacyRules.length > 0 || orchRules.length > 0) {
      serviceFindings.push({
        serviceId: service.id,
        serviceName: service.name,
        teams,
        legacyRules,
        orchRules,
      });
    }
  }

  // Check global orchestrations
  console.log('Checking global orchestrations...\n');
  const globalFindings = await checkGlobalOrchestrations();

  // ---------------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------------

  const totalSuppressed = serviceFindings.length + globalFindings.length;

  if (totalSuppressed === 0) {
    console.log('No suppression rules found.');
    return;
  }

  // Service-level findings
  if (serviceFindings.length > 0) {
    console.log(`Services with suppression rules: ${serviceFindings.length}`);
    console.log('='.repeat(60));

    for (const f of serviceFindings) {
      console.log(`\nService: ${f.serviceName}`);
      console.log(`   ID:    ${f.serviceId}`);
      console.log(`   Teams: ${f.teams}`);

      if (f.legacyRules.length > 0) {
        console.log(`   Legacy event rules with suppress (${f.legacyRules.length}):`);
        f.legacyRules.forEach((r) =>
          console.log(`     - [${r.ruleId}] ${r.label}`)
        );
      }

      if (f.orchRules.length > 0) {
        console.log(`   Service orchestration rules with suppress (${f.orchRules.length}):`);
        f.orchRules.forEach((r) =>
          console.log(`     - [${r.ruleSet}/${r.ruleId}] ${r.label}`)
        );
      }
    }
  }

  // Global orchestration findings
  if (globalFindings.length > 0) {
    console.log(`\nGlobal orchestrations with suppression rules: ${globalFindings.length}`);
    console.log('='.repeat(60));

    for (const f of globalFindings) {
      console.log(`\nOrchestration: ${f.orchestrationName}`);
      console.log(`   ID: ${f.orchestrationId}`);
      console.log(`   Suppressed rules (${f.suppressedRules.length}):`);
      f.suppressedRules.forEach((r) =>
        console.log(`     - [${r.ruleSet}/${r.ruleId}] ${r.label}`)
      );
    }
  }

  // Write markdown report
  const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const outputPath  = path.join(__dirname, 'suppressionReport.md');
  fs.writeFileSync(outputPath, generateMarkdown(serviceFindings, globalFindings, generatedAt));
  console.log(`\nReport written to ${outputPath}`);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
