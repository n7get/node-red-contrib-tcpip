"use strict";

/**
 * message-utils.js
 * ----------------
 * Framework-agnostic helpers for building the message envelopes that flow
 * out of every node. Mirrors the node-red-contrib-ax25 contract so that
 * every outbound message is guaranteed to carry `timestamp` + `status`, and
 * every error additionally carries `errorCode` + `errorText`.
 */

const crypto = require("crypto");

/**
 * ISO-8601 timestamp for the current instant.
 * @returns {string}
 */
function nowTimestamp() {
  return new Date().toISOString();
}

/**
 * Generate a prefixed, collision-resistant id, e.g. makeMessageId("sess").
 * @param {string} [prefix="id"]
 * @returns {string}
 */
function makeMessageId(prefix) {
  const p = prefix || "id";
  return `${p}-${crypto.randomUUID()}`;
}

/**
 * Build a success envelope. Always stamps `timestamp` and `status:"ok"`.
 * @param {object} [fields] extra fields merged into the envelope.
 * @returns {object}
 */
function okEnvelope(fields) {
  return Object.assign({ timestamp: nowTimestamp(), status: "ok" }, fields || {});
}

/**
 * Build an error envelope. Always stamps `timestamp`, `status:"error"`,
 * `errorCode` (machine readable, SCREAMING_SNAKE) and `errorText` (human).
 * @param {string} errorCode
 * @param {string} errorText
 * @param {object} [fields] extra fields merged into the envelope.
 * @returns {object}
 */
function errorEnvelope(errorCode, errorText, fields) {
  return Object.assign(
    { timestamp: nowTimestamp(), status: "error", errorCode, errorText },
    fields || {}
  );
}

module.exports = {
  nowTimestamp,
  makeMessageId,
  okEnvelope,
  errorEnvelope,
};
