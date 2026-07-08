'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const {
  getAllTeams,
  resolveTagId,
  getTeamIdsByTagId,
} = require('./lib/pagerduty');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printTeam(index, team, matchedTags) {
  console.log(`${index}. ${team.name}`);
  console.log(`   ID:          ${team.id}`);
  console.log(`   Description: ${team.description || 'N/A'}`);
  console.log(`   Tags:        ${matchedTags.length ? matchedTags.join(', ') : 'N/A'}`);
  console.log(`   URL:         ${team.html_url}`);
  console.log('');
}

// The only tags we care about for migration status reporting.
const MIGRATION_TAGS = ['Complete', 'WIP'];

/**
 * Build a teamId → Set<tagLabel> map for the migration status tags only
 * (Complete and WIP).
 */
async function buildFullTagMap() {
  const tagMap = new Map(); // teamId → Set<tagLabel>

  await Promise.all(
    MIGRATION_TAGS.map(async (label) => {
      const tag = await resolveTagId(label);
      if (!tag) return;
      const teamIds = await getTeamIdsByTagId(tag.id);
      for (const teamId of teamIds) {
        if (!tagMap.has(teamId)) tagMap.set(teamId, new Set());
        tagMap.get(teamId).add(label);
      }
    })
  );

  return tagMap;
}

// Tag sort order for the report.
const TAG_ORDER = ['Complete', 'WIP'];

function sortTags(tags) {
  return [...tags].sort((a, b) => {
    const ai = TAG_ORDER.indexOf(a);
    const bi = TAG_ORDER.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });
}

// Sort rows: Complete first, then WIP, then TerraformManaged-only, then untagged, then alpha within each group.
function statusSortKey(tags) {
  if (tags.includes('Complete')) return 0;
  if (tags.includes('WIP')) return 1;
  if (tags.length > 0) return 2;
  return 3;
}

/**
 * Write a markdown report to teams-report.md.
 *
 * @param {{ team: object, tags: string[] }[]} rows
 */
function writeReport(rows) {
  const reportPath = path.join(__dirname, 'teams-report.md');
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  const sorted = [...rows].sort((a, b) => {
    const sk = statusSortKey(a.tags) - statusSortKey(b.tags);
    return sk !== 0 ? sk : a.team.name.localeCompare(b.team.name);
  });

  const lines = [
    '# PagerDuty Teams — Migration Status',
    '',
    `_Generated: ${now}_`,
    '',
    `**Total teams: ${sorted.length}**`,
    '',
    '| # | Team Name | Tags |',
    '|---|-----------|------|',
    ...sorted.map(({ team, tags }, i) => {
      const tagStr = tags.length ? sortTags(tags).join(', ') : '—';
      return `| ${i + 1} | ${team.name} | ${tagStr} |`;
    }),
    '',
  ];

  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  console.log(`\nReport written to: ${reportPath}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const requestedTagNames = process.argv.slice(2);

  // ── No tags: list all teams with full tag status ─────────────────────────
  if (requestedTagNames.length === 0) {
    console.log('Fetching all PagerDuty teams and their tags...\n');

    const [allTeams, tagMap] = await Promise.all([
      getAllTeams(),
      buildFullTagMap(),
    ]);

    if (allTeams.length === 0) {
      console.log('No teams found.');
      return;
    }

    const rows = allTeams.map((team) => ({
      team,
      tags: tagMap.has(team.id) ? [...tagMap.get(team.id)] : [],
    }));

    console.log(`Total teams found: ${allTeams.length}\n`);
    console.log('Teams:');
    console.log('------');
    rows
      .sort((a, b) => a.team.name.localeCompare(b.team.name))
      .forEach(({ team, tags }, i) => printTeam(i + 1, team, tags));

    writeReport(rows);
    return;
  }

  // ── Tags provided: filter to teams with those tags ───────────────────────
  console.log(`Resolving tag(s): ${requestedTagNames.join(', ')}\n`);

  const resolvedTags = [];
  for (const name of requestedTagNames) {
    const tag = await resolveTagId(name);
    if (tag) {
      resolvedTags.push({ name, id: tag.id });
      console.log(`  Found tag "${name}" → ID: ${tag.id}`);
    } else {
      console.warn(`  Warning: tag "${name}" not found — skipping.`);
    }
  }

  if (resolvedTags.length === 0) {
    console.error('\nNone of the requested tags were found. Exiting.');
    process.exit(1);
  }

  // ── Fetch team IDs for each filter tag (union) ───────────────────────────
  console.log('\nFetching teams for each tag...\n');

  const filterTagMap = new Map(); // teamId → Set of filter-matched tag names

  for (const { name, id } of resolvedTags) {
    const teamIds = await getTeamIdsByTagId(id);
    console.log(`  Tag "${name}": ${teamIds.length} team(s)`);
    for (const teamId of teamIds) {
      if (!filterTagMap.has(teamId)) filterTagMap.set(teamId, new Set());
      filterTagMap.get(teamId).add(name);
    }
  }

  if (filterTagMap.size === 0) {
    console.log('\nNo teams found for the given tag(s).');
    return;
  }

  // ── Enrich matched teams with ALL their tags (not just the filter tags) ──
  console.log(`\nFetching full tag status for ${filterTagMap.size} matched team(s)...\n`);

  const [allTeams, fullTagMap] = await Promise.all([
    getAllTeams(),
    buildFullTagMap(),
  ]);

  const teamById = new Map(allTeams.map((t) => [t.id, t]));

  const rows = [...filterTagMap.keys()]
    .map((id) => ({
      team: teamById.get(id),
      tags: fullTagMap.has(id) ? [...fullTagMap.get(id)] : [],
    }))
    .filter(({ team }) => team != null)
    .sort((a, b) => a.team.name.localeCompare(b.team.name));

  console.log(`Total matching teams: ${rows.length}\n`);
  console.log('Teams:');
  console.log('------');
  rows.forEach(({ team, tags }, i) => printTeam(i + 1, team, tags));

  writeReport(rows);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
