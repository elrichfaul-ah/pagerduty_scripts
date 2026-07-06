'use strict';

const BASE_URL  = 'https://api.pagerduty.com';
const MAX_PAGES = 200; // safety cap — prevents infinite loops on broken pagination

// ---------------------------------------------------------------------------
// Environment validation
// Validate once at module load so callers get an immediate, clear error
// rather than a cryptic API 401 deep in a run.
// ---------------------------------------------------------------------------

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable: ${name}\n` +
      `Set it in the .env file or export it:  export ${name}=<value>`
    );
  }
  return value.trim();
}

// Cached at module load — fail fast if missing.
const API_KEY   = requireEnv('PAGERDUTY_API_KEY');
const FROM_EMAIL = requireEnv('PAGERDUTY_FROM_EMAIL');

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Extract a readable error message from a failed PagerDuty response.
 * The API returns JSON errors in the shape { error: { message, errors[] } }.
 */
async function extractErrorMessage(response, path) {
  const text = await response.text();
  try {
    const json = JSON.parse(text);
    const msg  = json?.error?.message || json?.message || text;
    const errs = json?.error?.errors;
    const detail = errs && errs.length ? ` (${errs.join('; ')})` : '';
    return `PagerDuty API ${response.status} on ${path}: ${msg}${detail}`;
  } catch {
    return `PagerDuty API ${response.status} on ${path}: ${text}`;
  }
}

/**
 * Perform a fetch with automatic retry on HTTP 429 (rate limit).
 * Respects the Retry-After header when present; falls back to exponential backoff.
 *
 * @param {string} url
 * @param {object} options  — fetch options
 * @param {number} maxRetries
 */
async function fetchWithRetry(url, options, maxRetries = 5) {
  let attempt = 0;

  while (true) {
    const response = await fetch(url, options);

    if (response.status !== 429) return response;

    if (attempt >= maxRetries) {
      throw new Error(`Rate-limited by PagerDuty after ${maxRetries} retries on ${url}`);
    }

    const retryAfter = response.headers.get('Retry-After');
    const delayMs    = retryAfter
      ? parseInt(retryAfter, 10) * 1000
      : Math.min(1000 * 2 ** attempt, 32000); // exponential backoff, cap at 32 s

    console.warn(`  [rate-limit] 429 received — retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${maxRetries})...`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    attempt++;
  }
}

async function pdGet(path) {
  const url      = `${BASE_URL}${path}`;
  const response = await fetchWithRetry(url, {
    method:  'GET',
    headers: {
      Accept:        'application/vnd.pagerduty+json;version=2',
      Authorization: `Token token=${API_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(await extractErrorMessage(response, `GET ${path}`));
  }

  return response.json();
}

async function pdPost(path, body) {
  const url      = `${BASE_URL}${path}`;
  const response = await fetchWithRetry(url, {
    method:  'POST',
    headers: {
      Accept:         'application/vnd.pagerduty+json;version=2',
      Authorization:  `Token token=${API_KEY}`,
      'Content-Type': 'application/json',
      From:           FROM_EMAIL,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(await extractErrorMessage(response, `POST ${path}`));
  }

  return response.json();
}

// ---------------------------------------------------------------------------
// Pagination helper — works for any paginated PagerDuty collection.
// basePath may already contain query params (e.g. /tags?query=foo).
// MAX_PAGES prevents infinite loops on unexpected API behaviour.
// ---------------------------------------------------------------------------

async function fetchAllPages(basePath, resultKey, limit = 100) {
  const results = [];
  let offset    = 0;
  let more      = true;
  let pages     = 0;
  const sep     = basePath.includes('?') ? '&' : '?';

  while (more) {
    if (pages >= MAX_PAGES) {
      throw new Error(
        `fetchAllPages safety cap hit (${MAX_PAGES} pages) for ${basePath}. ` +
        'This likely indicates an API pagination bug.'
      );
    }

    const path = `${basePath}${sep}limit=${limit}&offset=${offset}`;
    const data = await pdGet(path);
    results.push(...(data[resultKey] || []));
    more    = data.more;
    offset += limit;
    pages++;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

async function getAllTeams() {
  return fetchAllPages('/teams', 'teams');
}

/**
 * Find a team by exact name match (case-insensitive).
 * Returns the team object or null if not found.
 */
async function getTeamByName(name) {
  const teams = await getAllTeams();
  return teams.find((t) => t.name.toLowerCase() === name.toLowerCase()) || null;
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/**
 * Search for a tag whose label exactly matches tagName (case-insensitive).
 * PagerDuty's ?query= does a substring/prefix match; we exact-match client-side.
 */
async function resolveTagId(tagName) {
  const tags = await fetchAllPages(
    `/tags?query=${encodeURIComponent(tagName)}`,
    'tags'
  );
  return tags.find((t) => t.label.toLowerCase() === tagName.toLowerCase()) || null;
}

/**
 * Get all team IDs associated with a tag ID.
 * Endpoint: GET /tags/{id}/teams
 */
async function getTeamIdsByTagId(tagId) {
  const refs = await fetchAllPages(`/tags/${tagId}/teams`, 'teams');
  return refs.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

/**
 * Returns the first service associated with a team, or null if none found.
 */
async function getFirstServiceForTeam(teamId) {
  const data     = await pdGet(`/services?team_ids[]=${teamId}&limit=1`);
  const services = data.services || [];
  return services.length > 0 ? services[0] : null;
}

// ---------------------------------------------------------------------------
// Priorities
// ---------------------------------------------------------------------------

/**
 * Resolves a priority name (e.g. 'P2') to its PagerDuty ID.
 * Returns the priority object or null if not found.
 */
async function resolvePriorityId(name) {
  const data       = await pdGet('/priorities');
  const priorities = data.priorities || [];
  return priorities.find((p) => p.name.toUpperCase() === name.toUpperCase()) || null;
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

/**
 * Creates a PagerDuty incident against the given service.
 * priorityId is optional — omit to create without a priority label.
 *
 * @param {object} params
 * @param {string}      params.title
 * @param {string}      params.serviceId
 * @param {string}      params.body        — incident details text
 * @param {string}      [params.urgency]   — 'high' | 'low'  (default: 'low')
 * @param {string|null} [params.priorityId]
 * @param {Array}       [params.links]     — [{ href, text }] links attached to the incident
 */
async function createIncident({ title, serviceId, body, urgency = 'low', priorityId = null, links = [] }) {
  const incident = {
    type:    'incident',
    title,
    service: { id: serviceId, type: 'service_reference' },
    urgency,
    body: {
      type:    'incident_body',
      details: body,
    },
  };

  if (priorityId) {
    incident.priority = { id: priorityId, type: 'priority_reference' };
  }

  if (links.length > 0) {
    incident.links = links;
  }

  return pdPost('/incidents', { incident });
}

module.exports = {
  pdGet,
  pdPost,
  fetchAllPages,
  getAllTeams,
  getTeamByName,
  resolveTagId,
  getTeamIdsByTagId,
  getFirstServiceForTeam,
  resolvePriorityId,
  createIncident,
};
