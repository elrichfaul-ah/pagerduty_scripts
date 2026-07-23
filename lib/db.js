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

  // Index on teamId for efficient coverage queries.
  // Not unique — a team can accumulate multiple records over time
  // (e.g. dry-run records, or re-runs via --team); coverage logic
  // at the app layer always uses the most-recent dryRun:false record.
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

/**
 * Returns a Map<teamId, coverage> describing the real-notification state of
 * every team that has at least one dryRun:false record.
 *
 * Only the most-recent record per teamId is considered (sorted by notifiedAt
 * descending) so a team that was re-notified via --team always reflects its
 * latest state.
 *
 * Each coverage object has the shape:
 *   {
 *     hasPD:        boolean,   // incidentId is a non-null, non-empty string
 *     hasOpsGenie:  boolean,   // opsgenieRequestId is a non-null, non-empty string
 *     teamId:       string,
 *     teamName:     string,
 *     serviceId:    string,
 *     serviceName:  string,
 *     incidentId:   string|null,
 *     opsgenieRequestId: string|null,
 *     notifiedAt:   Date,
 *   }
 */
async function getCoverageStatus() {
  const docs = await db
    .collection(COLLECTION_NAME)
    .find({ dryRun: false })
    .sort({ notifiedAt: -1 })
    .toArray();

  const statusMap = new Map();

  for (const doc of docs) {
    // First document seen per teamId is the most recent (we sorted desc above).
    if (statusMap.has(doc.teamId)) continue;

    statusMap.set(doc.teamId, {
      hasPD:       typeof doc.incidentId === 'string' && doc.incidentId.length > 0,
      hasOpsGenie: typeof doc.opsgenieRequestId === 'string' && doc.opsgenieRequestId.length > 0,
      teamId:      doc.teamId,
      teamName:    doc.teamName,
      serviceId:   doc.serviceId,
      serviceName: doc.serviceName,
      incidentId:  doc.incidentId ?? null,
      opsgenieRequestId: doc.opsgenieRequestId ?? null,
      notifiedAt:  doc.notifiedAt,
    });
  }

  return statusMap;
}

/**
 * Patches the most-recent real (dryRun:false) notification record for a team
 * that is currently missing an OpsGenie request ID — setting opsgenieRequestId
 * to the supplied value and stamping opsgenieNotifiedAt with the current time.
 *
 * Uses findOneAndUpdate so only a single document is touched even if the team
 * has multiple records (e.g. from previous --team re-runs).
 *
 * @param {string} teamId
 * @param {string} opsgenieRequestId
 */
async function updateOpsgenieRequestId(teamId, opsgenieRequestId) {
  await db.collection(COLLECTION_NAME).findOneAndUpdate(
    {
      teamId,
      dryRun: false,
      $or: [
        { opsgenieRequestId: { $exists: false } },
        { opsgenieRequestId: null },
      ],
    },
    {
      $set: {
        opsgenieRequestId,
        opsgenieNotifiedAt: new Date(),
      },
    },
    { sort: { notifiedAt: -1 } }
  );
}

// ---------------------------------------------------------------------------
// Opsgenie Deprecation Notices
// ---------------------------------------------------------------------------

const DEPRECATION_COLLECTION = 'opsgenie_deprecation_notices';

/**
 * Insert a deprecation notice record.
 * Keyed on teamName (OpsGenie name) — no PD teamId required.
 *
 * @param {object} doc
 * @param {string}       doc.teamName
 * @param {string|null}  doc.opsgenieRequestId  — null for dry-run records
 * @param {boolean}      doc.dryRun
 */
async function recordDeprecationNotice({ teamName, opsgenieRequestId, dryRun }) {
  await db.collection(DEPRECATION_COLLECTION).insertOne({
    teamName,
    opsgenieRequestId,
    dryRun,
    sentAt: new Date(),
  });
}

/**
 * Returns a Set<teamNameLower> of OpsGenie team names that have already
 * received a real (dryRun:false) deprecation notice.
 */
async function getNotifiedDeprecationTeams() {
  const docs = await db
    .collection(DEPRECATION_COLLECTION)
    .find({ dryRun: false }, { projection: { teamName: 1 } })
    .toArray();
  return new Set(docs.map((d) => d.teamName.toLowerCase()));
}

module.exports = {
  connect,
  disconnect,
  isTeamNotified,
  recordNotification,
  getNotifiedTeamIds,
  getCoverageStatus,
  updateOpsgenieRequestId,
  recordDeprecationNotice,
  getNotifiedDeprecationTeams,
};
