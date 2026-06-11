"use strict";

const assert = require("assert");
const proxyquire = require("proxyquire").noCallThru();
const { createMockRED } = require("../helpers/mock-red");
const { FakeUdpSocket, lastCreated: lastSocket } = require("../helpers/fake-udp-socket");
const store = require("../../lib/runtime-store");

// ---- store cleanup ----

function clearStore() {
  for (const id of [...store.registry.byId.keys()]) store.purgeSession(id);
  store.sessionIndex.clear();
}

// ---- module loading ----

let RED;
let UdpOutNode;

function loadUdpOut() {
  RED = createMockRED();
  const mod = proxyquire("../../nodes/udp-out", {
    "../lib/udp-socket": FakeUdpSocket,
  });
  mod(RED);
  UdpOutNode = RED._types["udp-out"];
}

function makeNode(config) {
  return new UdpOutNode(config || {});
}

function closeNode(node) {
  if (node._handlers && node._handlers.close) {
    node._handlers.close(false, () => {});
  }
}

function input(node, msg) {
  node._handlers.input(msg, null, () => {});
}

// ============================================================

describe("udp-out node", () => {
  beforeEach(loadUdpOut);
  afterEach(clearStore);

  // ---- construction ----

  describe("construction", () => {
    it("creates a session record in the registry", () => {
      const node = makeNode({ host: "1.2.3.4", port: 5000 });
      assert.strictEqual(store.registry.list().length, 1);
      closeNode(node);
    });

    it("sets status to 'ready'", () => {
      const node = makeNode({ host: "1.2.3.4", port: 5000 });
      const ready = node._statuses.find((s) => s.text === "ready");
      assert.ok(ready, "expected a 'ready' status");
      closeNode(node);
    });
  });

  // ---- input validation ----

  describe("input validation", () => {
    it("sends SEND_INVALID when host is absent", () => {
      const node = makeNode({ port: 5000 });
      input(node, { payload: "hi" });
      const sent = node._sent[0];
      assert.strictEqual(sent.errorCode, "SEND_INVALID");
      closeNode(node);
    });

    it("sends SEND_INVALID when port is absent", () => {
      const node = makeNode({ host: "1.2.3.4" });
      input(node, { payload: "hi" });
      assert.strictEqual(node._sent[0].errorCode, "SEND_INVALID");
      closeNode(node);
    });

    it("sends SEND_INVALID when neither host nor port are configured or in the message", () => {
      const node = makeNode({});
      input(node, { payload: "hi" });
      assert.strictEqual(node._sent[0].errorCode, "SEND_INVALID");
      closeNode(node);
    });

    it("sends PAYLOAD_INVALID when payload is a number", () => {
      const node = makeNode({ host: "1.2.3.4", port: 5000 });
      input(node, { payload: 42 });
      assert.strictEqual(node._sent[0].errorCode, "PAYLOAD_INVALID");
      closeNode(node);
    });

    it("sends PAYLOAD_INVALID when payload is null", () => {
      const node = makeNode({ host: "1.2.3.4", port: 5000 });
      input(node, { payload: null });
      assert.strictEqual(node._sent[0].errorCode, "PAYLOAD_INVALID");
      closeNode(node);
    });
  });

  // ---- successful send ----

  describe("successful send", () => {
    it("passes the Buffer to the socket", () => {
      const node = makeNode({ host: "1.2.3.4", port: 5000 });
      input(node, { payload: "hello" });

      const socket = lastSocket();
      assert.ok(socket._lastSend, "socket.send should have been called");
      assert.ok(Buffer.isBuffer(socket._lastSend.data));
      assert.strictEqual(socket._lastSend.data.toString(), "hello");
      assert.strictEqual(socket._lastSend.host, "1.2.3.4");
      assert.strictEqual(socket._lastSend.port, 5000);
      closeNode(node);
    });

    it("accepts a Buffer payload directly", () => {
      const node = makeNode({ host: "1.2.3.4", port: 5000 });
      const buf = Buffer.from("binary");
      input(node, { payload: buf });

      const socket = lastSocket();
      assert.ok(Buffer.isBuffer(socket._lastSend.data));
      assert.strictEqual(socket._lastSend.data.toString(), "binary");
      closeNode(node);
    });

    it("emits a 'sent' ok envelope with byte count", () => {
      const node = makeNode({ host: "1.2.3.4", port: 5000 });
      input(node, { payload: "hello" });

      const ack = node._sent[0];
      assert.strictEqual(ack.status, "ok");
      assert.strictEqual(ack.event, "sent");
      assert.strictEqual(ack.bytes, 5);
      assert.strictEqual(ack.host, "1.2.3.4");
      assert.strictEqual(ack.port, 5000);
      closeNode(node);
    });

    it("uses msg.host / msg.port to override config values", () => {
      const node = makeNode({ host: "1.2.3.4", port: 5000 });
      input(node, { host: "9.9.9.9", port: 6006, payload: "hi" });

      const socket = lastSocket();
      assert.strictEqual(socket._lastSend.host, "9.9.9.9");
      assert.strictEqual(socket._lastSend.port, 6006);
      closeNode(node);
    });
  });

  // ---- send error ----

  describe("send error", () => {
    it("sends a UDP_SEND_FAILED error envelope when the socket reports an error", () => {
      const node = makeNode({ host: "1.2.3.4", port: 5000 });
      const socket = lastSocket();
      socket._sendErr = new Error("network unreachable");

      input(node, { payload: "hello" });

      const err = node._sent[0];
      assert.strictEqual(err.status, "error");
      assert.strictEqual(err.errorCode, "UDP_SEND_FAILED");
      closeNode(node);
    });
  });

  // ---- socket error event ----

  describe("socket error event", () => {
    it("sends a UDP_ERROR envelope when the socket emits an error", () => {
      const node = makeNode({ host: "1.2.3.4", port: 5000 });
      lastSocket().simulateError("socket exploded");

      const err = node._sent[0];
      assert.strictEqual(err.errorCode, "UDP_ERROR");
      assert.strictEqual(err.errorText, "socket exploded");
      closeNode(node);
    });
  });

  // ---- close handler ----

  describe("node close", () => {
    it("closes the socket", () => {
      const node = makeNode({ host: "1.2.3.4", port: 5000 });
      const socket = lastSocket();
      closeNode(node);
      assert.strictEqual(socket._closed, true);
    });

    it("purges the session from the store", () => {
      const node = makeNode({ host: "1.2.3.4", port: 5000 });
      const sessionId = store.registry.list()[0].sessionId;
      closeNode(node);
      assert.strictEqual(store.registry.has(sessionId), false);
      assert.strictEqual(store.transportForSession(sessionId), null);
    });
  });
});
