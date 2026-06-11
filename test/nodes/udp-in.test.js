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
let UdpInNode;

function loadUdpIn() {
  RED = createMockRED();
  const mod = proxyquire("../../nodes/udp-in", {
    "../lib/udp-socket": FakeUdpSocket,
  });
  mod(RED);
  UdpInNode = RED._types["udp-in"];
}

function makeNode(config) {
  return new UdpInNode(config || {});
}

function closeNode(node) {
  if (node._handlers && node._handlers.close) {
    node._handlers.close(false, () => {});
  }
}

// ============================================================

describe("udp-in node", () => {
  beforeEach(loadUdpIn);
  afterEach(clearStore);

  // ---- missing port ----

  describe("configuration validation", () => {
    it("sets error status and does not bind when port is absent", () => {
      const node = makeNode({ mode: "binary" }); // no port
      const errorStatus = node._statuses.find((s) => s.fill === "red");
      assert.ok(errorStatus, "should have set an error status");
      assert.strictEqual(errorStatus.text, "missing port");
    });

    it("does not create a session record when port is absent", () => {
      makeNode({ mode: "binary" });
      assert.strictEqual(store.registry.list().length, 0);
    });
  });

  // ---- listening ----

  describe("listening event", () => {
    it("emits a 'listening' ok envelope on output 1 when the socket binds", () => {
      const node = makeNode({ port: 5005, mode: "binary" });
      lastSocket().simulateListening(5005, "0.0.0.0");

      const evt = node._sent.find(
        (m) => Array.isArray(m) && m[0] && m[0].event === "listening"
      );
      assert.ok(evt, "expected a listening envelope");
      assert.strictEqual(evt[0].status, "ok");
      assert.strictEqual(evt[0].port, 5005);
      assert.ok(typeof evt[0].sessionId === "string");
      assert.strictEqual(evt[1], null);
      closeNode(node);
    });

    it("sets status to green/dot on listening", () => {
      const node = makeNode({ port: 5005, mode: "binary" });
      lastSocket().simulateListening(5005);

      const green = node._statuses.find(
        (s) => s.fill === "green" && s.shape === "dot"
      );
      assert.ok(green, "expected green status");
      closeNode(node);
    });

    it("creates a session record in the registry", () => {
      const node = makeNode({ port: 5005, mode: "binary" });
      lastSocket().simulateListening(5005);

      assert.strictEqual(store.registry.list().length, 1);
      closeNode(node);
    });
  });

  // ---- message events ----

  describe("message in binary mode", () => {
    it("emits a data ok envelope on output 2 with a Buffer payload", () => {
      const node = makeNode({ port: 5006, mode: "binary" });
      const socket = lastSocket();
      socket.simulateListening(5006);
      socket.simulateMessage(Buffer.from("ping"), {
        address: "10.0.0.1",
        port: 6000,
      });

      const dataMsg = node._sent.find(
        (m) => Array.isArray(m) && m[1] && m[1].event === "data"
      );
      assert.ok(dataMsg, "expected a data envelope");
      assert.ok(Buffer.isBuffer(dataMsg[1].payload));
      assert.strictEqual(dataMsg[1].payload.toString(), "ping");
      assert.deepStrictEqual(dataMsg[1].rinfo, { address: "10.0.0.1", port: 6000 });
      assert.strictEqual(dataMsg[0], null);
      closeNode(node);
    });
  });

  describe("message in utf8 mode", () => {
    it("emits a data envelope with a string payload", () => {
      const node = makeNode({ port: 5007, mode: "utf8" });
      const socket = lastSocket();
      socket.simulateListening(5007);
      socket.simulateMessage(Buffer.from("hello"), {
        address: "10.0.0.2",
        port: 7000,
      });

      const dataMsg = node._sent.find(
        (m) => Array.isArray(m) && m[1] && m[1].event === "data"
      );
      assert.ok(dataMsg);
      assert.strictEqual(typeof dataMsg[1].payload, "string");
      assert.strictEqual(dataMsg[1].payload, "hello");
      closeNode(node);
    });
  });

  // ---- error event ----

  describe("error event", () => {
    it("emits a UDP_ERROR error envelope on output 1", () => {
      const node = makeNode({ port: 5008, mode: "binary" });
      const socket = lastSocket();
      socket.simulateListening(5008);
      socket.simulateError("bind failed");

      const errMsg = node._sent.find(
        (m) => Array.isArray(m) && m[0] && m[0].status === "error"
      );
      assert.ok(errMsg, "expected an error envelope");
      assert.strictEqual(errMsg[0].errorCode, "UDP_ERROR");
      assert.strictEqual(errMsg[0].errorText, "bind failed");
      closeNode(node);
    });

    it("sets status to red/dot on error", () => {
      const node = makeNode({ port: 5008, mode: "binary" });
      lastSocket().simulateListening(5008);
      lastSocket().simulateError("oops");

      const red = node._statuses.find((s) => s.fill === "red" && s.shape === "dot");
      assert.ok(red);
      closeNode(node);
    });
  });

  // ---- close handler ----

  describe("node close", () => {
    it("closes the socket", () => {
      const node = makeNode({ port: 5009, mode: "binary" });
      const socket = lastSocket();
      socket.simulateListening(5009);

      closeNode(node);
      assert.strictEqual(socket._closed, true);
    });

    it("purges the session from the store", () => {
      const node = makeNode({ port: 5010, mode: "binary" });
      const socket = lastSocket();
      socket.simulateListening(5010);

      const sessionId = store.registry.list()[0].sessionId;
      closeNode(node);

      assert.strictEqual(store.registry.has(sessionId), false);
      assert.strictEqual(store.transportForSession(sessionId), null);
    });
  });
});
