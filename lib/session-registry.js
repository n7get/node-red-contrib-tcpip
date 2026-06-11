"use strict";

/**
 * session-registry.js
 * -------------------
 * CRUD store for session *records* (metadata only — never the live socket).
 * Modeled on node-red-contrib-ax25's registry: records are keyed by
 * sessionId, every getter returns a COPY so callers can never mutate
 * internal state, and `create` performs collision detection.
 *
 * A session record describes one TCP connection or one UDP socket:
 *   {
 *     sessionId, kind: "tcp" | "udp",
 *     localHost, localPort, remoteHost, remotePort,
 *     state, mode, createdAt, updatedAt, lastActivityAt, metadata
 *   }
 */

const { makeMessageId, nowTimestamp } = require("./message-utils");

function SessionRegistry() {
  // sessionId -> record
  this.byId = new Map();
}

/**
 * Create and store a new session record.
 * @param {object} input record fields. `input.sessionId` may be supplied to
 *        force an id, otherwise one is auto-generated.
 * @returns {object} a COPY of the stored record.
 * @throws {Error} with code SESSION_ID_CONFLICT if the id already exists.
 */
SessionRegistry.prototype.create = function create(input) {
  const fields = input || {};
  const sessionId = fields.sessionId || makeMessageId("sess");

  if (this.byId.has(sessionId)) {
    const err = new Error("Session already exists");
    err.code = "SESSION_ID_CONFLICT";
    throw err;
  }

  const ts = nowTimestamp();
  const record = {
    sessionId,
    kind: fields.kind || "tcp",
    localHost: fields.localHost || null,
    localPort: fields.localPort || null,
    remoteHost: fields.remoteHost || null,
    remotePort: fields.remotePort || null,
    state: fields.state || "connecting",
    mode: fields.mode || "binary",
    createdAt: ts,
    updatedAt: ts,
    lastActivityAt: ts,
    metadata: fields.metadata || {},
  };

  this.byId.set(sessionId, record);
  return Object.assign({}, record);
};

/**
 * Fetch a copy of a record by id, or null.
 * @param {string} sessionId
 * @returns {object|null}
 */
SessionRegistry.prototype.get = function get(sessionId) {
  const record = this.byId.get(sessionId);
  return record ? Object.assign({}, record) : null;
};

/**
 * Whether a record exists.
 * @param {string} sessionId
 * @returns {boolean}
 */
SessionRegistry.prototype.has = function has(sessionId) {
  return this.byId.has(sessionId);
};

/**
 * List copies of all records, optionally filtered by a predicate.
 * @param {function(object):boolean} [predicate]
 * @returns {object[]}
 */
SessionRegistry.prototype.list = function list(predicate) {
  const out = [];
  for (const record of this.byId.values()) {
    if (!predicate || predicate(record)) {
      out.push(Object.assign({}, record));
    }
  }
  return out;
};

/**
 * Merge a patch into a record and refresh `updatedAt`.
 * @param {string} sessionId
 * @param {object} patch
 * @returns {object|null} updated copy, or null if not found.
 */
SessionRegistry.prototype.update = function update(sessionId, patch) {
  const record = this.byId.get(sessionId);
  if (!record) {
    return null;
  }
  Object.assign(record, patch || {}, { updatedAt: nowTimestamp() });
  return Object.assign({}, record);
};

/**
 * Refresh just the activity timestamp (called on every tx/rx).
 * @param {string} sessionId
 */
SessionRegistry.prototype.touch = function touch(sessionId) {
  const record = this.byId.get(sessionId);
  if (record) {
    record.lastActivityAt = nowTimestamp();
  }
};

/**
 * Remove a record.
 * @param {string} sessionId
 * @returns {boolean} true if a record was removed.
 */
SessionRegistry.prototype.remove = function remove(sessionId) {
  return this.byId.delete(sessionId);
};

/**
 * Remove every record (used on full shutdown).
 */
SessionRegistry.prototype.clear = function clear() {
  this.byId.clear();
};

module.exports = SessionRegistry;
