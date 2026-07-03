'use strict';

require('dotenv').config();

const {
  fetchAllPages,
  getAllTeams,
  resolveTagId,
  getTeamIdsByTagId,
} = require('./lib/pagerduty');

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printTeam(index, team, matchedTags) {
  console.log(`${index}. ${team.name}`);
  console.log(`   ID:          ${team.id}`);
  console.log(`   Description: ${team.description || 'N/A'}`);
  console.log(`   Tags:        ${matchedTags.length ? matchedTags.join(', ') : 'N/A'}`);
  console.log(`   URL:         ${team.html_url}`);
  console.log('');
}

async function main() {
  const requestedTagNames = process.argv.slice(2);

  // ── No tags: list all teams ──────────────────────────────────────────────
  if (requestedTagNames.length === 0) {
    console.log('Fetching all PagerDuty teams...\n');
    const teams = await getAllTeams();

    if (teams.length === 0) {
      console.log('No teams found.');
      return;
    }

    console.log(`Total teams found: ${teams.length}\n`);
    console.log('Teams:');
    console.log('------');
    teams.forEach((team, i) => printTeam(i + 1, team, []));
    return;
  }

  // ── Tags provided: resolve names → IDs ──────────────────────────────────
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

  // ── Fetch team IDs for each tag (union) ──────────────────────────────────
  console.log('\nFetching teams for each tag...\n');

  // Map: teamId → Set of matched tag names
  const teamTagMap = new Map();

  for (const { name, id } of resolvedTags) {
    const teamIds = await getTeamIdsByTagId(id);
    console.log(`  Tag "${name}": ${teamIds.length} team(s)`);
    for (const teamId of teamIds) {
      if (!teamTagMap.has(teamId)) teamTagMap.set(teamId, new Set());
      teamTagMap.get(teamId).add(name);
    }
  }

  if (teamTagMap.size === 0) {
    console.log('\nNo teams found for the given tag(s).');
    return;
  }

  // ── Fetch full team details for matched team IDs ──────────────────────────
  console.log(`\nFetching full details for ${teamTagMap.size} matched team(s)...\n`);

  const allTeams = await getAllTeams();
  const teamById = new Map(allTeams.map((t) => [t.id, t]));

  const matchedTeams = [...teamTagMap.entries()]
    .map(([id, tagSet]) => ({ team: teamById.get(id), tags: [...tagSet] }))
    .filter(({ team }) => team != null)
    .sort((a, b) => a.team.name.localeCompare(b.team.name));

  console.log(`Total matching teams: ${matchedTeams.length}\n`);
  console.log('Teams:');
  console.log('------');
  matchedTeams.forEach(({ team, tags }, i) => printTeam(i + 1, team, tags));
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
