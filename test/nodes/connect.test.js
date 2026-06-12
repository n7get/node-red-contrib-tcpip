"use strict";

const assert = require("assert");
const proxyquire = require("proxyquire").noCallThru();
const { createMockRED } = require("../helpers/mock-red");
const { FakeTcpClient, lastCreated: lastClient } = require("../helpers/fake-tcp-client");
const store = require("../../lib/runtime-store");

// ---- store cleanup ----

function clearStore() {
  for (const id of [...store.registry.byId.keys()]) store.purgeSession(id);
  store.sessionIndex.clear();
}

// ---- module loading ----

let RED;
let ConnectNode;

function loadConnect() {
  RED = createMockRED();
  const mod = proxyquire("../../nodes/connect", {
    "../lib/tcp-client": FakeTcpClient,
  });
  mod(RED);
  ConnectNode = RED._types["tcp-connect"];
}

function makeNode(config) {
  return new ConnectNode(Object.assign({ mode: "binary" }, config || {}));
}

function closeNode(node) {
  if (node._handlers && node._handlers.close) {
    node._handlers.close(false, () => {});
  }
}

// Simulate the input handler; null send/done fall back to node.send / no-op.
function input(node, msg) {
  node._handlers.input(msg, null, () => {});
}

// ============================================================

describe("tcp-connect node", () => {
  beforeEach(loadConnect);
  afterEach(clearStore);

  // ---- validation ----

  describe("input validation", () => {
    it("sends CONNECT_INVALID when host is missing", () => {
      const node = makeNode({ port: 9000 });
      input(node, { port: 9000 });
      assert.strictEqual(node._sent[0][0].errorCode, "CONNECT_INVALID");
      closeNode(node);
    });

    it("sends CONNECT_INVALID when port is missing", () => {
      const node = makeNode({ host: "localhost" });
      input(node, { host: "localhost" });
      assert.strictEqual(node._sent[0][0].errorCode, "CONNECT_INVALID");
      closeNode(node);
    });

    it("sends SESSION_ID_CONFLICT when the supplied sessionId already exists", () => {
      store.registry.create({ sessionId: "pre-existing" });
      const node = makeNode({ host: "localhost", port: 9000 });
      input(node, { host: "localhost", port: 9000, sessionId: "pre-existing" });
      assert.strictEqual(node._sent[0][0].errorCode, "SESSION_ID_CONFLICT");
      closeNode(node);
    });

    it("sets status to 'bad waitFor regex' for an invalid waitFor pattern", () => {
      const node = makeNode({ host: "localhost", port: 9000, waitFor: "[bad" });
      // The "bad waitFor regex" status is set first; "idle" may follow it.
      const badStatus = node._statuses.find((s) => s.text === "bad waitFor regex");
      assert.ok(badStatus, "expected a 'bad waitFor regex' status");
      closeNode(node);
    });
  });

  // ---- immediate ack ----

  describe("connect ack", () => {
    it("emits a 'connecting' ok envelope on output 1 immediately", () => {
      const node = makeNode({ host: "1.2.3.4", port: 9000 });
      input(node, { host: "1.2.3.4", port: 9000 });

      const ack = node._sent[0];
      assert.ok(Array.isArray(ack), "send arg should be an array");
      assert.strictEqual(ack[0].status, "ok");
      assert.strictEqual(ack[0].event, "connecting");
      assert.ok(typeof ack[0].sessionId === "string");
      assert.strictEqual(ack[1], null);
      closeNode(node);
    });

    it("uses msg.host / msg.port when config values are absent", () => {
      const node = makeNode({});
      input(node, { host: "10.0.0.1", port: 7777 });
      const ack = node._sent[0];
      assert.strictEqual(ack[0].remoteHost, "10.0.0.1");
      assert.strictEqual(ack[0].remotePort, 7777);
      closeNode(node);
    });

    it("creates a session record in the registry", () => {
      const node = makeNode({ host: "1.2.3.4", port: 9000 });
      input(node, { host: "1.2.3.4", port: 9000 });
      assert.strictEqual(store.registry.list().length, 1);
      closeNode(node);
    });
  });

  // ---- lifecycle events ----

  describe("lifecycle events", () => {
    it("emits 'connected' on output 1 after transport fires connect", () => {
      const node = makeNode({ host: "1.2.3.4", port: 9000 });
      input(node, { host: "1.2.3.4", port: 9000 });
      lastClient().simulateConnect(55555);

      const connected = node._sent.find(
        (m) => Array.isArray(m) && m[0] && m[0].event === "connected"
      );
      assert.ok(connected, "expected a 'connected' envelope");
      assert.strictEqual(connected[0].localPort, 55555);
      assert.strictEqual(connected[1], null);
      closeNode(node);
    });

    it("sets status to green/dot on connect", () => {
      const node = makeNode({ host: "1.2.3.4", port: 9000 });
      input(node, { host: "1.2.3.4", port: 9000 });
      lastClient().simulateConnect();

      const green = node._statuses.find(
        (s) => s.fill === "green" && s.shape === "dot"
      );
      assert.ok(green, "expected green status");
      closeNode(node);
    });

    it("emits 'disconnected' on output 1 after transport fires close", () => {
      const node = makeNode({ host: "1.2.3.4", port: 9000 });
      input(node, { host: "1.2.3.4", port: 9000 });
      const client = lastClient();
      client.simulateConnect();
      client.simulateClose();

      const disc = node._sent.find(
        (m) => Array.isArray(m) && m[0] && m[0].event === "disconnected"
      );
      assert.ok(disc, "expected a 'disconnected' envelope");
      closeNode(node);
    });

    it("emits a TIMEOUT error envelope on transport timeout", () => {
      const node = makeNode({ host: "1.2.3.4", port: 9000 });
      input(node, { host: "1.2.3.4", port: 9000 });
      lastClient().simulateConnect();
      lastClient().simulateTimeout();

      const err = node._sent.find(
        (m) => Array.isArray(m) && m[0] && m[0].errorCode === "TIMEOUT"
      );
      assert.ok(err, "expected a TIMEOUT error envelope");
      closeNode(node);
    });

    it("emits a CONNECT_FAILED error envelope on transport error", () => {
      const node = makeNode({ host: "1.2.3.4", port: 9000 });
      input(node, { host: "1.2.3.4", port: 9000 });
      lastClient().simulateError("ECONNREFUSED", "Connection refused");

      const err = node._sent.find(
        (m) => Array.isArray(m) && m[0] && m[0].status === "error"
      );
      assert.ok(err, "expected an error envelope");
      closeNode(node);
    });

    it("ignores lifecycle events for sessions it does not own", () => {
      const node = makeNode({ host: "1.2.3.4", port: 9000 });
      input(node, { host: "1.2.3.4", port: 9000 });
      const initialCount = node._sent.length;

      // Emit a lifecycle event for a foreign sessionId
      store.globalBus.emit("conn-lifecycle", {
        event: "connected",
        sessionId: "foreign-session",
      });

      assert.strictEqual(node._sent.length, initialCount);
      closeNode(node);
    });
  });

  // ---- data delivery ----

  describe("data delivery", () => {
    it("routes binary inbound data to output 2", () => {
      const node = makeNode({ host: "1.2.3.4", port: 9000, mode: "binary" });
      input(node, { host: "1.2.3.4", port: 9000 });
      const client = lastClient();
      client.simulateConnect();
      client.simulateData("hello");

      const dataMsg = node._sent.find(
        (m) => Array.isArray(m) && m[1] && m[1].event === "data"
      );
      assert.ok(dataMsg, "expected a data envelope on output 2");
      assert.ok(Buffer.isBuffer(dataMsg[1].payload));
      assert.strictEqual(dataMsg[1].payload.toString(), "hello");
      assert.strictEqual(dataMsg[0], null);
      closeNode(node);
    });

    it("routes line-mode inbound data to output 2 as strings", () => {
      const node = makeNode({ host: "1.2.3.4", port: 9000, mode: "line" });
      input(node, { host: "1.2.3.4", port: 9000 });
      const client = lastClient();
      client.simulateConnect();
      client.simulateData("line1\nline2\n");

      const dataMessages = node._sent.filter(
        (m) => Array.isArray(m) && m[1] && m[1].event === "data"
      );
      assert.strictEqual(dataMessages.length, 2);
      assert.strictEqual(dataMessages[0][1].payload, "line1");
      assert.strictEqual(dataMessages[1][1].payload, "line2");
      closeNode(node);
    });

    it("does not deliver data claimed by a different node", () => {
      const node = makeNode({ host: "1.2.3.4", port: 9000, mode: "binary" });
      input(node, { host: "1.2.3.4", port: 9000 });
      const client = lastClient();
      client.simulateConnect();

      // Transfer the data claim to a different node object
      const sessions = store.registry.list();
      const sessionId = sessions[0].sessionId;
      store.setClaim(sessionId, { id: "other-node" }, null);

      const before = node._sent.length;
      client.simulateData("should-not-arrive");
      assert.strictEqual(node._sent.length, before);
      closeNode(node);
    });
  });

  // ---- autoConnect ----

  describe("autoConnect", () => {
    it("initiates a connection on setImmediate when autoConnect is true", function (done) {
      const node = makeNode({
        host: "1.2.3.4",
        port: 9000,
        autoConnect: true,
      });
      setImmediate(() => {
        const ack = node._sent[0];
        assert.ok(ack, "should have sent a connecting ack");
        assert.strictEqual(ack[0].event, "connecting");
        closeNode(node);
        done();
      });
    });
  });

  // ---- close handler ----

  describe("node close", () => {
    it("purges all sessions owned by this node", () => {
      const node = makeNode({ host: "1.2.3.4", port: 9000 });
      input(node, { host: "1.2.3.4", port: 9000 });
      lastClient().simulateConnect();

      const sessionId = store.registry.list()[0].sessionId;
      closeNode(node);

      assert.strictEqual(store.registry.has(sessionId), false);
      assert.strictEqual(store.transportForSession(sessionId), null);
    });

    it("removes globalBus listeners so subsequent events do not reach the node", () => {
      const node = makeNode({ host: "1.2.3.4", port: 9000 });
      input(node, { host: "1.2.3.4", port: 9000 });
      lastClient().simulateConnect();

      closeNode(node);
      const countAfterClose = node._sent.length;

      store.globalBus.emit("conn-lifecycle", {
        event: "disconnected",
        sessionId: "ghost",
      });
      assert.strictEqual(node._sent.length, countAfterClose);
    });
  });

  // ---- inactivity timer ----

  describe("inactivity timer", () => {
    it("fires a TIMEOUT error on the data-claim holder when the timer expires", function (done) {
      const node = makeNode({ host: "1.2.3.4", port: 9000 });
      input(node, { host: "1.2.3.4", port: 9000 });
      lastClient().simulateConnect();

      const sessionId = store.registry.list()[0].sessionId;

      // A send node claims the data output.
      const fakeClaimHolder = { send: (m) => { received = m; } };
      let received = null;
      store.setClaim(sessionId, fakeClaimHolder, null);

      // Arm the timer for 20 ms.
      store.globalBus.emit("conn-timeout-set", { sessionId, timeoutMs: 20 });

      setTimeout(() => {
        assert.ok(received, "expected a timeout message to be delivered");
        assert.strictEqual(received[0].errorCode, "TIMEOUT");
        assert.strictEqual(received[0].event, "timeout");
        assert.strictEqual(received[0].sessionId, sessionId);
        assert.strictEqual(received[1], null);
        closeNode(node);
        done();
      }, 50);
    });

    it("ignores conn-timeout-set for sessions not owned by this node", function (done) {
      const node = makeNode({ host: "1.2.3.4", port: 9000 });
      // Do not connect — ownSessions remains empty.

      let received = null;
      const fakeHolder = { send: (m) => { received = m; } };
      const foreignId = "not-mine";
      store.registry.create({ sessionId: foreignId, state: "connected" });
      store.setClaim(foreignId, fakeHolder, null);

      store.globalBus.emit("conn-timeout-set", { sessionId: foreignId, timeoutMs: 20 });

      setTimeout(() => {
        assert.strictEqual(received, null, "should not fire for a foreign session");
        store.purgeSession(foreignId);
        closeNode(node);
        done();
      }, 50);
    });

    it("resets the timer when inbound data arrives", function (done) {
      const node = makeNode({ host: "1.2.3.4", port: 9000 });
      input(node, { host: "1.2.3.4", port: 9000 });
      const client = lastClient();
      client.simulateConnect();

      const sessionId = store.registry.list()[0].sessionId;
      store.registry.update(sessionId, { timeoutMs: 40 });

      let received = null;
      const fakeHolder = { send: (m) => { received = m; } };
      store.setClaim(sessionId, fakeHolder, null);

      // Arm timer for 40 ms, then reset it with data at 20 ms.
      store.globalBus.emit("conn-timeout-set", { sessionId, timeoutMs: 40 });
      setTimeout(() => {
        client.simulateData("ping"); // should reset the 40 ms timer
      }, 20);

      // After the original 40 ms window the timer should NOT have fired yet
      // (it was reset). After 70 ms the reset timer (40 ms from t=20) fires.
      setTimeout(() => {
        assert.strictEqual(received, null, "timer should not have fired at 30 ms");
      }, 30);

      setTimeout(() => {
        assert.ok(received, "timer should have fired after the reset window");
        assert.strictEqual(received[0].errorCode, "TIMEOUT");
        closeNode(node);
        done();
      }, 80);
    });

    it("cancels the timer when the session closes", function (done) {
      const node = makeNode({ host: "1.2.3.4", port: 9000 });
      input(node, { host: "1.2.3.4", port: 9000 });
      const client = lastClient();
      client.simulateConnect();

      const sessionId = store.registry.list()[0].sessionId;

      let received = null;
      const fakeHolder = { send: (m) => { received = m; } };
      store.setClaim(sessionId, fakeHolder, null);

      store.globalBus.emit("conn-timeout-set", { sessionId, timeoutMs: 30 });

      // Close the session before the timer fires.
      client.simulateClose();

      setTimeout(() => {
        assert.strictEqual(received, null, "timer should have been cancelled on close");
        closeNode(node);
        done();
      }, 60);
    });

    it("cancels timers for all owned sessions when the node closes", function (done) {
      const node = makeNode({ host: "1.2.3.4", port: 9000 });
      input(node, { host: "1.2.3.4", port: 9000 });
      lastClient().simulateConnect();

      const sessionId = store.registry.list()[0].sessionId;

      let received = null;
      const fakeHolder = { send: (m) => { received = m; } };
      store.setClaim(sessionId, fakeHolder, null);

      store.globalBus.emit("conn-timeout-set", { sessionId, timeoutMs: 30 });

      closeNode(node); // should cancel the timer

      setTimeout(() => {
        assert.strictEqual(received, null, "timer should have been cancelled on node close");
        done();
      }, 60);
    });
  });
});
