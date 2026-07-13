'use strict';

const BASE_URL  = 'https://api.opsgenie.com';
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
const API_KEY = requireEnv('OPSGENIE_API_KEY');

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Extract a readable error message from a failed OpsGenie response.
 * The API returns JSON errors in the shape { message, errors[] }.
 */
async function extractErrorMessage(response, path) {
  const text = await response.text();
  try {
    const json   = JSON.parse(text);
    const msg    = json?.message || text;
    const errors = json?.errors;
    const detail = errors && Object.keys(errors).length
      ? ` (${Object.values(errors).flat().join('; ')})`
      : '';
    return `OpsGenie API ${response.status} on ${path}: ${msg}${detail}`;
  } catch {
    return `OpsGenie API ${response.status} on ${path}: ${text}`;
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
      throw new Error(`Rate-limited by OpsGenie after ${maxRetries} retries on ${url}`);
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

async function ogGet(path) {
  const url      = `${BASE_URL}${path}`;
  const response = await fetchWithRetry(url, {
    method:  'GET',
    headers: {
      Authorization:  `GenieKey ${API_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(await extractErrorMessage(response, `GET ${path}`));
  }

  return response.json();
}

async function ogPost(path, body) {
  const url      = `${BASE_URL}${path}`;
  const response = await fetchWithRetry(url, {
    method:  'POST',
    headers: {
      Authorization:  `GenieKey ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(await extractErrorMessage(response, `POST ${path}`));
  }

  return response.json();
}

// ---------------------------------------------------------------------------
// Pagination helper
// ---------------------------------------------------------------------------

async function fetchAllPages(basePath, resultKey, limit = 100) {
  const results = [];
  let offset    = 0;
  let pages     = 0;
  const sep     = basePath.includes('?') ? '&' : '?';

  while (true) {
    if (pages >= MAX_PAGES) {
      throw new Error(
        `fetchAllPages safety cap hit (${MAX_PAGES} pages) for ${basePath}. ` +
        'This likely indicates an API pagination bug.'
      );
    }

    const path = `${basePath}${sep}limit=${limit}&offset=${offset}`;
    const data = await ogGet(path);
    const page = data[resultKey] || [];
    results.push(...page);

    // OpsGenie paginates via totalCount vs collected count
    if (results.length >= (data.totalCount ?? results.length) || page.length < limit) break;

    offset += limit;
    pages++;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

/**
 * Find an OpsGenie team by exact name match (case-insensitive).
 * Returns the team object or null if not found.
 */
async function getTeamByName(name) {
  const data  = await ogGet('/v2/teams');
  const teams = data.data || [];
  return teams.find((t) => t.name.toLowerCase() === name.toLowerCase()) || null;
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

/**
 * Creates an OpsGenie alert targeting a team by name.
 *
 * @param {object} params
 * @param {string}      params.message     — short alert message (max 130 chars)
 * @param {string}      params.description — full details
 * @param {string}      params.teamName    — must match an existing OpsGenie team name exactly
 * @param {string|null} [params.runbookUrl] — optional runbook URL appended to the description
 * @returns {string} requestId — OpsGenie's async request ID for the created alert
 */
async function createAlert({ message, description, teamName, runbookUrl = null }) {
  const fullDescription = runbookUrl
    ? `${description}\n\nRunbook: ${runbookUrl}`
    : description;

  const body = {
    message,
    description: fullDescription,
    responders: [{ name: teamName, type: 'team' }],
    priority:   'P2',
  };

  const response = await ogPost('/v2/alerts', body);

  // OpsGenie returns HTTP 202 with { result, took, requestId }
  return response.requestId;
}

module.exports = {
  ogGet,
  getTeamByName,
  createAlert,
};
