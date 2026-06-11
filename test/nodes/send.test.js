"use strict";

const assert = require("assert");
const { createMockRED } = require("../helpers/mock-red");
const store = require("../../lib/runtime-store");

// ---- module loading ----
// tcp-send requires no transport mocking — it fetches the transport from the
// store, so we seed the store directly.

let RED;
let SendNode;

before(() => {
  RED = createMockRED();
  require("../../nodes/send")(RED);
  SendNode = RED._types["tcp-send"];
});

// ---- store cleanup ----

function clearStore() {
  for (const id of [...store.registry.byId.keys()]) store.purgeSession(id);
  store.sessionIndex.clear();
}

afterEach(clearStore);

// ---- helpers ----

function makeNode(config) {
  return new SendNode(config || {});
}

function closeNode(node) {
  if (node._handlers && node._handlers.close) {
    node._handlers.close(false, () => {});
  }
}

function input(node, msg) {
  node._handlers.input(msg, null, () => {});
}

/**
 * Seed a session record and optionally register a fake transport.
 * Returns the sessionId.
 */
function seedSession(opts) {
  const defaults = { kind: "tcp", state: "connected", mode: "binary" };
  const rec = store.registry.create(Object.assign(defaults, opts || {}));
  return rec.sessionId;
}

// ============================================================

describe("tcp-send node", () => {
  // ---- error paths ----

  describe("input validation", () => {
    it("sends SESSION_NOT_FOUND when msg.sessionId is absent", () => {
      const node = makeNode();
      input(node, { payload: "hello" });
      assert.strictEqual(node._sent[0][0].errorCode, "SESSION_NOT_FOUND");
      closeNode(node);
    });

    it("sends SESSION_NOT_FOUND when msg.sessionId is unknown", () => {
      const node = makeNode();
      input(node, { sessionId: "no-such", payload: "hello" });
      assert.strictEqual(node._sent[0][0].errorCode, "SESSION_NOT_FOUND");
      closeNode(node);
    });

    it("sends SESSION_NOT_CONNECTED when the session state is not 'connected'", () => {
      const sessionId = seedSession({ state: "connecting" });
      const node = makeNode();
      input(node, { sessionId, payload: "hello" });
      assert.strictEqual(node._sent[0][0].errorCode, "SESSION_NOT_CONNECTED");
      closeNode(node);
    });

    it("sends PAYLOAD_INVALID when payload is a number", () => {
      const sessionId = seedSession();
      store.indexSession(sessionId, {
        write: () => true,
      });
      const node = makeNode();
      input(node, { sessionId, payload: 42 });
      assert.strictEqual(node._sent[0][0].errorCode, "PAYLOAD_INVALID");
      closeNode(node);
    });

    it("sends PAYLOAD_INVALID when an array item is neither string nor Buffer", () => {
      const sessionId = seedSession();
      store.indexSession(sessionId, { write: () => true });
      const node = makeNode();
      input(node, { sessionId, payload: ["ok", 123] });
      assert.strictEqual(node._sent[0][0].errorCode, "PAYLOAD_INVALID");
      closeNode(node);
    });

    it("sends SOCKET_NOT_CONNECTED when no transport is indexed", () => {
      const sessionId = seedSession();
      // No transport indexed for the session.
      const node = makeNode();
      input(node, { sessionId, payload: "hello" });
      assert.strictEqual(node._sent[0][0].errorCode, "SOCKET_NOT_CONNECTED");
      closeNode(node);
    });

    it("sends SOCKET_NOT_CONNECTED when transport.write throws", () => {
      const sessionId = seedSession();
      store.indexSession(sessionId, {
        write() {
          const err = new Error("Socket is not connected");
          err.code = "SOCKET_NOT_CONNECTED";
          throw err;
        },
      });
      const node = makeNode();
      input(node, { sessionId, payload: "hello" });
      assert.strictEqual(node._sent[0][0].errorCode, "SOCKET_NOT_CONNECTED");
      closeNode(node);
    });

    it("sets status to 'bad waitFor regex' for an invalid waitFor pattern", () => {
      const node = makeNode({ waitFor: "[bad" });
      const lastStatus = node._statuses[node._statuses.length - 1];
      assert.strictEqual(lastStatus.text, "bad waitFor regex");
      closeNode(node);
    });
  });

  // ---- happy path ----

  describe("successful send", () => {
    it("writes payload to the transport", () => {
      const written = [];
      const sessionId = seedSession();
      store.indexSession(sessionId, { write: (d) => written.push(d) });

      const node = makeNode();
      input(node, { sessionId, payload: "hello" });

      assert.strictEqual(written.length, 1);
      assert.strictEqual(written[0], "hello");
      closeNode(node);
    });

    it("writes each item in an array payload separately", () => {
      const written = [];
      const sessionId = seedSession();
      store.indexSession(sessionId, { write: (d) => written.push(d) });

      const node = makeNode();
      input(node, { sessionId, payload: ["a", Buffer.from("b")] });

      assert.strictEqual(written.length, 2);
      assert.strictEqual(written[0], "a");
      assert.ok(Buffer.isBuffer(written[1]));
      closeNode(node);
    });

    it("emits a 'sent' ok envelope on output 1", () => {
      const sessionId = seedSession();
      store.indexSession(sessionId, { write: () => {} });

      const node = makeNode();
      input(node, { sessionId, payload: "hello" });

      const ack = node._sent[0];
      assert.ok(Array.isArray(ack));
      assert.strictEqual(ack[0].status, "ok");
      assert.strictEqual(ack[0].event, "sent");
      assert.strictEqual(ack[0].sessionId, sessionId);
      assert.ok(typeof ack[0].messageId === "string");
      assert.strictEqual(ack[1], null);
      closeNode(node);
    });

    it("claims the session's data output for this node", () => {
      const sessionId = seedSession();
      store.indexSession(sessionId, { write: () => {} });

      const node = makeNode();
      input(node, { sessionId, payload: "hi" });

      const claim = store.getClaim(sessionId);
      assert.ok(claim, "claim should exist");
      assert.strictEqual(claim.node, node);
      closeNode(node);
    });
  });

  // ---- data delivery ----

  describe("data delivery via globalBus", () => {
    it("delivers conn-data to output 2 after claiming the session", () => {
      const sessionId = seedSession();
      store.indexSession(sessionId, { write: () => {} });

      const node = makeNode();
      input(node, { sessionId, payload: "hi" });

      // Simulate inbound data on the bus
      store.globalBus.emit("conn-data", {
        sessionId,
        chunk: Buffer.from("response"),
      });

      const dataMsg = node._sent.find(
        (m) => Array.isArray(m) && m[1] && m[1].event === "data"
      );
      assert.ok(dataMsg, "expected a data envelope on output 2");
      assert.ok(Buffer.isBuffer(dataMsg[1].payload));
      assert.strictEqual(dataMsg[1].payload.toString(), "response");
      closeNode(node);
    });

    it("does not deliver data for a session claimed by another node", () => {
      const sessionId = seedSession();
      store.indexSession(sessionId, { write: () => {} });
      store.setClaim(sessionId, { id: "other-node" }, null);

      const node = makeNode();

      store.globalBus.emit("conn-data", {
        sessionId,
        chunk: Buffer.from("should-not-arrive"),
      });

      const dataMsg = node._sent.find(
        (m) => Array.isArray(m) && m[1] && m[1].event === "data"
      );
      assert.ok(!dataMsg, "should not have received data for another node's claim");
      closeNode(node);
    });
  });

  // ---- claim transfer ----

  describe("claim transfer", () => {
    it("flushes the pending waitFor buffer to the previous owner before taking the claim", () => {
      const sessionId = seedSession();
      store.indexSession(sessionId, { write: () => {} });

      // Previous owner with buffered lines
      const prevNode = makeNode();
      store.setClaim(sessionId, prevNode, /READY/);
      store.setWaitForBuffer(sessionId, ["line1", "line2"]);

      // New send node takes ownership
      const newNode = makeNode();
      input(newNode, { sessionId, payload: "hi" });

      // prevNode should have received the flushed buffer
      const flushed = prevNode._sent.find(
        (m) => Array.isArray(m) && m[1] && m[1].payload
      );
      assert.ok(flushed, "previous owner should receive the pending buffer");
      assert.deepStrictEqual(flushed[1].payload, ["line1", "line2"]);

      // New node should now hold the claim
      assert.strictEqual(store.getClaim(sessionId).node, newNode);

      closeNode(prevNode);
      closeNode(newNode);
    });
  });

  // ---- close handler ----

  describe("node close", () => {
    it("removes the conn-data globalBus listener", () => {
      const node = makeNode();
      closeNode(node);

      const sessionId = seedSession();
      store.setClaim(sessionId, node, null);

      const before = node._sent.length;
      store.globalBus.emit("conn-data", {
        sessionId,
        chunk: Buffer.from("after-close"),
      });
      assert.strictEqual(node._sent.length, before);
    });
  });
});
