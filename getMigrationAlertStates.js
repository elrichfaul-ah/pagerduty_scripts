'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const { connect, disconnect, getCoverageStatus } = require('./lib/db');
const { pdGet } = require('./lib/pagerduty');
const { ogGet } = require('./lib/opsgenie');

const CONCURRENCY = 10;

function displayPagerDutyState(incident) {
  if (!incident) return 'Missing notification';
  return incident.status.charAt(0).toUpperCase() + incident.status.slice(1);
}

function displayOpsgenieState(alert) {
  if (!alert) return 'Missing notification';
  const status = alert.status.charAt(0).toUpperCase() + alert.status.slice(1);
  return `${status} / ${alert.acknowledged ? 'Acknowledged' : 'Unacknowledged'}`;
}

function calculateRisk(pdState, opsgenieState) {
  if (!pdState.ok || !opsgenieState.ok) return 'Unknown';

  const pdHandled = ['acknowledged', 'resolved'].includes(pdState.data.status);
  const opsgenieHandled =
    opsgenieState.data.acknowledged || opsgenieState.data.status === 'closed';

  if (pdHandled && opsgenieHandled) return 'None';
  if (pdHandled || opsgenieHandled) return 'Low';
  return 'High';
}

async function getPagerDutyState(incidentId) {
  if (!incidentId) {
    return { ok: false, display: 'Missing notification' };
  }

  try {
    const response = await pdGet(`/incidents/${incidentId}`);
    return {
      ok: true,
      data: response.incident,
      display: displayPagerDutyState(response.incident),
    };
  } catch (err) {
    return { ok: false, display: `Lookup failed: ${err.message}` };
  }
}

async function getOpsgenieState(requestId) {
  if (!requestId) {
    return { ok: false, display: 'Missing notification' };
  }

  try {
    const request = await ogGet(`/v2/alerts/requests/${encodeURIComponent(requestId)}`);
    const alertId = request.data?.alertId;

    if (!alertId) {
      throw new Error('Opsgenie request did not resolve to an alert ID');
    }

    const response = await ogGet(
      `/v2/alerts/${encodeURIComponent(alertId)}?identifierType=id`
    );

    return {
      ok: true,
      data: response.data,
      display: displayOpsgenieState(response.data),
    };
  } catch (err) {
    return { ok: false, display: `Lookup failed: ${err.message}` };
  }
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );

  return results;
}

function escapeMarkdown(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function writeReport(rows) {
  const now = new Date();
  const generatedAt = now.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const timestamp = now.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
  const reportsDir = path.join(__dirname, 'reports');
  const reportPath = path.join(
    reportsDir,
    `${timestamp}-migration-alert-states-report.md`
  );

  fs.mkdirSync(reportsDir, { recursive: true });

  const riskOrder = { High: 0, Low: 1, Unknown: 2, None: 3 };
  const sorted = [...rows].sort(
    (a, b) =>
      riskOrder[a.risk] - riskOrder[b.risk] ||
      a.application.localeCompare(b.application)
  );

  const counts = { None: 0, Low: 0, High: 0, Unknown: 0 };
  for (const row of sorted) counts[row.risk]++;

  const lines = [
    '# Migration Alert States',
    '',
    `_Generated: ${generatedAt}_`,
    '',
    '## Summary',
    '',
    '| Risk | Applications |',
    '|---|---:|',
    `| High | ${counts.High} |`,
    `| Low | ${counts.Low} |`,
    `| None | ${counts.None} |`,
    `| Unknown | ${counts.Unknown} |`,
    `| **Total** | **${sorted.length}** |`,
    '',
    '## Applications',
    '',
    '| Application | PagerDuty State | Opsgenie State | Risk | Notified At |',
    '|---|---|---|---|---|',
    ...sorted.map((row) =>
      `| ${escapeMarkdown(row.application)} | ${escapeMarkdown(row.pagerDuty)} | ` +
      `${escapeMarkdown(row.opsgenie)} | ${row.risk} | ${row.notifiedAt} |`
    ),
    '',
  ];

  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  return reportPath;
}

async function main() {
  console.log('Loading notification records...');
  await connect();

  try {
    const coverage = await getCoverageStatus();
    const applications = [...coverage.values()];
    console.log(`Checking ${applications.length} applications...`);

    const rows = await mapWithConcurrency(
      applications,
      CONCURRENCY,
      async (application) => {
        const [pagerDuty, opsgenie] = await Promise.all([
          getPagerDutyState(application.incidentId),
          getOpsgenieState(application.opsgenieRequestId),
        ]);

        return {
          application: application.teamName,
          pagerDuty: pagerDuty.display,
          opsgenie: opsgenie.display,
          risk: calculateRisk(pagerDuty, opsgenie),
          notifiedAt: new Date(application.notifiedAt).toISOString(),
        };
      }
    );

    const reportPath = writeReport(rows);
    console.log(`Report written to ${reportPath}`);
  } finally {
    await disconnect();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
