'use strict';

const { MongoClient } = require('mongodb');

const DB_NAME         = 'pagerduty_migration';
const COLLECTION_NAME = 'team_notifications';

let client = null;
let db     = null;

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

async function connect() {
  if (client) {
    throw new Error('MongoDB client is already connected. Call disconnect() first.');
  }

  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';

  client = new MongoClient(uri, {
    // Fail fast if MongoDB is unreachable rather than hanging for 30 s
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS:         5000,
    // Conservative pool — this is a short-lived CLI script, not a server
    maxPoolSize: 5,
    minPoolSize: 1,
  });

  await client.connect();
  db = client.db(DB_NAME);

  // Index on teamId for efficient deduplication queries.
  // Not unique — single-team mode intentionally allows re-notification
  // of an already-notified team; deduplication is enforced at the app layer
  // for bulk runs only.
  await db.collection(COLLECTION_NAME).createIndex(
    { teamId: 1 },
    { background: true }
  );
}

async function disconnect() {
  if (client) {
    await client.close();
    client = null;
    db     = null;
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Returns true if a real (non-dry-run) notification has already been recorded
 * for this team. Dry-run records do NOT count.
 */
async function isTeamNotified(teamId) {
  const doc = await db.collection(COLLECTION_NAME).findOne(
    { teamId, dryRun: false },
    { projection: { _id: 1 } }  // only fetch the _id — we only care about existence
  );
  return doc !== null;
}

/**
 * Insert a notification record with an explicit, fixed set of fields.
 * Rejects unknown fields to prevent accidental data pollution.
 *
 * @param {object} doc
 * @param {string}       doc.teamId
 * @param {string}       doc.teamName
 * @param {string}       doc.serviceId
 * @param {string}       doc.serviceName
 * @param {string|null}  doc.incidentId          — null for dry-run records
 * @param {string|null}  doc.opsgenieRequestId   — null for dry-run records
 * @param {boolean}      doc.dryRun
 */
async function recordNotification({ teamId, teamName, serviceId, serviceName, incidentId, opsgenieRequestId, dryRun }) {
  await db.collection(COLLECTION_NAME).insertOne({
    teamId,
    teamName,
    serviceId,
    serviceName,
    incidentId,
    opsgenieRequestId,
    dryRun,
    notifiedAt: new Date(),
  });
}

/**
 * Returns a Set of teamIds that have at least one real (non-dry-run) record.
 * Used by the bulk flow to skip already-notified teams.
 */
async function getNotifiedTeamIds() {
  const docs = await db
    .collection(COLLECTION_NAME)
    .find({ dryRun: false }, { projection: { teamId: 1 } })
    .toArray();
  return new Set(docs.map((d) => d.teamId));
}

module.exports = {
  connect,
  disconnect,
  isTeamNotified,
  recordNotification,
  getNotifiedTeamIds,
};
