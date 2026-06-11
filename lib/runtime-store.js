"use strict";

/**
 * runtime-store.js
 * ----------------
 * Process-wide coordination singleton. Because the TCP/IP module has no
 * config node, the runtime store is the single global place that lets the
 * `send` and `disconnect` nodes find a live connection from *only* a
 * sessionId.
 *
 * It holds:
 *   - registry     : SessionRegistry (session metadata records)
 *   - globalBus    : EventEmitter broadcasting "conn-data" / "conn-lifecycle"
 *                    for every session, so loosely-bound nodes subscribe once.
 *   - sessionIndex : Map<sessionId, transport>  (the TcpClient / UdpSocket)
 *   - claims       : Map<sessionId, { node, waitFor }>   output (data) claim
 *   - lifecycleClaims : Map<sessionId, node>  set once at connect, never moved
 *   - lineBuffers / waitForBuffers : per-session receive buffers
 *
 * The module is cached by `require`, so all nodes in the process share one
 * instance.
 */

const EventEmitter = require("events");
const SessionRegistry = require("./session-registry");
const { okEnvelope } = require("./message-utils");

const registry = new SessionRegistry();

const globalBus = new EventEmitter();
// Many nodes may subscribe; never warn about listener count.
globalBus.setMaxListeners(0);

/** sessionId -> live transport (TcpClient or UdpSocket). */
const sessionIndex = new Map();

/** sessionId -> { node, waitFor: RegExp|null } — owner of the data output. */
const claims = new Map();

/** sessionId -> node — owner of the lifecycle output (set at connect only). */
const lifecycleClaims = new Map();

/** sessionId -> partial line string (line mode). */
const lineBuffers = new Map();

/** sessionId -> string[] buffered lines awaiting a waitFor match. */
const waitForBuffers = new Map();

/* ----------------------------- transports ----------------------------- */

function indexSession(sessionId, transport) {
  sessionIndex.set(sessionId, transport);
}

function unindexSession(sessionId) {
  sessionIndex.delete(sessionId);
}

function transportForSession(sessionId) {
  return sessionIndex.get(sessionId) || null;
}

function hasSession(sessionId) {
  return sessionIndex.has(sessionId);
}

/* ------------------------------- claims -------------------------------- */

function setClaim(sessionId, node, waitFor) {
  claims.set(sessionId, { node, waitFor: waitFor || null });
}

function getClaim(sessionId) {
  return claims.get(sessionId) || null;
}

function clearClaim(sessionId) {
  claims.delete(sessionId);
}

function setLifecycleClaim(sessionId, node) {
  lifecycleClaims.set(sessionId, node);
}

function getLifecycleClaim(sessionId) {
  return lifecycleClaims.get(sessionId) || null;
}

function clearLifecycleClaim(sessionId) {
  lifecycleClaims.delete(sessionId);
}

/* --------------------------- receive buffers --------------------------- */

function getLineBuffer(sessionId) {
  return lineBuffers.get(sessionId) || "";
}

function setLineBuffer(sessionId, value) {
  lineBuffers.set(sessionId, value);
}

function getWaitForBuffer(sessionId) {
  return waitForBuffers.get(sessionId) || [];
}

function setWaitForBuffer(sessionId, arr) {
  waitForBuffers.set(sessionId, arr);
}

function clearBuffers(sessionId) {
  lineBuffers.delete(sessionId);
  waitForBuffers.delete(sessionId);
}

/* --------------------------- receive delivery -------------------------- */

/**
 * Turn an inbound chunk into one or more `data` envelopes according to the
 * session's mode, and route them to the current data-output claim owner.
 *
 * Modes:
 *   - "binary": emit each chunk immediately as { payload: Buffer }.
 *   - "line"  : accumulate, split on \r\n | \n | \r, emit one msg per line
 *               (payload = string). With a `waitFor` RegExp, buffer lines
 *               until one matches and emit { payload: [linesBefore], match }.
 *
 * @param {object} params
 * @param {string} params.sessionId
 * @param {string} params.mode            "binary" | "line"
 * @param {Buffer} params.chunk           inbound bytes
 * @param {object} [params.extra]         extra fields merged into envelopes
 * @param {function(object):void} emit    called once per outbound envelope
 */
function deliverData(params, emit) {
  const { sessionId, mode, chunk, extra } = params;
  const base = Object.assign({ event: "data", sessionId }, extra || {});

  if (mode !== "line") {
    emit(okEnvelope(Object.assign({}, base, { payload: chunk })));
    return;
  }

  // line mode
  let buffer = getLineBuffer(sessionId) + chunk.toString("utf8");
  const parts = buffer.split(/\r\n|\n|\r/);
  // The last element is an incomplete (trailing) fragment.
  const trailing = parts.pop();
  setLineBuffer(sessionId, trailing);

  const claim = getClaim(sessionId);
  const waitFor = claim ? claim.waitFor : null;

  if (!waitFor) {
    for (const line of parts) {
      emit(okEnvelope(Object.assign({}, base, { payload: line })));
    }
    return;
  }

  // waitFor mode: buffer complete lines until one matches the RegExp.
  let pending = getWaitForBuffer(sessionId);
  const flushMatch = (matchedLine) => {
    emit(
      okEnvelope(
        Object.assign({}, base, { payload: pending.slice(), match: matchedLine })
      )
    );
    pending = [];
  };

  for (const line of parts) {
    if (waitFor.test(line)) {
      flushMatch(line);
    } else {
      pending.push(line);
    }
  }
  // Also test the trailing fragment (handles prompts without a trailing EOL).
  if (trailing && waitFor.test(trailing)) {
    setLineBuffer(sessionId, "");
    flushMatch(trailing);
  }
  setWaitForBuffer(sessionId, pending);
}

/* ------------------------------ lifecycle ------------------------------ */

/**
 * Remove every trace of a session from the store (registry record, transport
 * index, claims and buffers). Safe to call multiple times.
 * @param {string} sessionId
 */
function purgeSession(sessionId) {
  registry.remove(sessionId);
  unindexSession(sessionId);
  clearClaim(sessionId);
  clearLifecycleClaim(sessionId);
  clearBuffers(sessionId);
}

module.exports = {
  registry,
  globalBus,
  sessionIndex,
  // transports
  indexSession,
  unindexSession,
  transportForSession,
  hasSession,
  // claims
  setClaim,
  getClaim,
  clearClaim,
  setLifecycleClaim,
  getLifecycleClaim,
  clearLifecycleClaim,
  // buffers
  getLineBuffer,
  setLineBuffer,
  getWaitForBuffer,
  setWaitForBuffer,
  clearBuffers,
  // delivery
  deliverData,
  // lifecycle
  purgeSession,
};
