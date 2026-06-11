"use strict";

const assert = require("assert");
const { createMockRED } = require("../helpers/mock-red");
const store = require("../../lib/runtime-store");

// ---- module loading ----

let RED;
let DisconnectNode;

before(() => {
  RED = createMockRED();
  require("../../nodes/disconnect")(RED);
  DisconnectNode = RED._types["tcp-disconnect"];
});

// ---- store cleanup ----

function clearStore() {
  for (const id of [...store.registry.byId.keys()]) store.purgeSession(id);
  store.sessionIndex.clear();
}

afterEach(clearStore);

// ---- helpers ----

function makeNode(config) {
  return new DisconnectNode(config || {});
}

function closeNode(node) {
  if (node._handlers && node._handlers.close) {
    node._handlers.close(false, () => {});
  }
}

function input(node, msg) {
  node._handlers.input(msg, null, () => {});
}

function seedSession(opts) {
  const defaults = { kind: "tcp", state: "connected", mode: "binary" };
  const rec = store.registry.create(Object.assign(defaults, opts || {}));
  return rec.sessionId;
}

// ============================================================

describe("tcp-disconnect node", () => {
  // ---- error paths ----

  describe("input validation", () => {
    it("sends SESSION_NOT_FOUND when msg.sessionId is absent", () => {
      const node = makeNode();
      input(node, {});
      // disconnect sends a bare envelope (not wrapped in an array)
      const sent = node._sent[0];
      assert.strictEqual(sent.errorCode, "SESSION_NOT_FOUND");
      closeNode(node);
    });

    it("sends SESSION_NOT_FOUND when msg.sessionId is unknown", () => {
      const node = makeNode();
      input(node, { sessionId: "no-such" });
      assert.strictEqual(node._sent[0].errorCode, "SESSION_NOT_FOUND");
      closeNode(node);
    });
  });

  // ---- happy path ----

  describe("successful disconnect", () => {
    it("calls transport.end() when available", () => {
      let endCalled = false;
      const sessionId = seedSession();
      store.indexSession(sessionId, {
        end() { endCalled = true; },
      });

      const node = makeNode();
      input(node, { sessionId });

      assert.ok(endCalled, "transport.end should be called");
      closeNode(node);
    });

    it("falls back to transport.close() when end() is absent", () => {
      let closeCalled = false;
      const sessionId = seedSession();
      store.indexSession(sessionId, {
        close() { closeCalled = true; },
      });

      const node = makeNode();
      input(node, { sessionId });

      assert.ok(closeCalled, "transport.close should be called as fallback");
      closeNode(node);
    });

    it("emits a 'disconnecting' ok envelope", () => {
      const sessionId = seedSession();
      store.indexSession(sessionId, { end: () => {} });

      const node = makeNode();
      input(node, { sessionId });

      const ack = node._sent[0];
      assert.strictEqual(ack.status, "ok");
      assert.strictEqual(ack.event, "disconnecting");
      assert.strictEqual(ack.sessionId, sessionId);
      closeNode(node);
    });

    it("updates the session state to 'disconnecting'", () => {
      const sessionId = seedSession();
      store.indexSession(sessionId, { end: () => {} });

      const node = makeNode();
      input(node, { sessionId });

      assert.strictEqual(store.registry.get(sessionId).state, "disconnecting");
      closeNode(node);
    });

    it("still emits the 'disconnecting' ack when no transport is indexed", () => {
      const sessionId = seedSession();
      // No transport in the store

      const node = makeNode();
      input(node, { sessionId });

      assert.strictEqual(node._sent[0].event, "disconnecting");
      closeNode(node);
    });
  });

  // ---- close handler ----

  describe("node close", () => {
    it("clears status and calls done without throwing", () => {
      const node = makeNode();
      let doneCalled = false;
      node._handlers.close(false, () => { doneCalled = true; });
      assert.ok(doneCalled);
      // Last status should be the empty object {} written by close
      const last = node._statuses[node._statuses.length - 1];
      assert.deepStrictEqual(last, {});
    });
  });
});
