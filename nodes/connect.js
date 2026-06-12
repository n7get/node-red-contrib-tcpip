"use strict";

/**
 * tcp-connect node
 * ----------------
 * Opens an outbound TCP/IPv4 connection to a remote server, allocates a
 * sessionId, and emits lifecycle events on output 1 (events) and inbound
 * data on output 2 (data).
 *
 * The node owns the transport (TcpClient) and bridges its events onto the
 * shared globalBus so that `send`/`disconnect` nodes can act on the same
 * session using only its sessionId. Output routing uses the "claim" pattern:
 *   - this node holds the lifecycle claim for the session for its lifetime,
 *   - this node initially holds the data claim (a later `send` may take over).
 */

const TcpClient = require("../lib/tcp-client");
const store = require("../lib/runtime-store");
const { okEnvelope, errorEnvelope } = require("../lib/message-utils");

module.exports = function (RED) {
  function TcpConnectNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    const cfgHost = (config.host || "").trim();
    const cfgPort = parseInt(config.port, 10);
    const mode = config.mode === "line" ? "line" : "binary";
    const timeout = parseInt(config.timeout, 10) || 0;
    const waitForStr = (config.waitFor || "").trim();
    const autoConnect = !!config.autoConnect;

    let waitFor = null;
    if (waitForStr) {
      try {
        waitFor = new RegExp(waitForStr);
      } catch (err) {
        node.status({ fill: "red", shape: "ring", text: "bad waitFor regex" });
      }
    }

    // Sessions created by THIS node (so close can tear them down).
    const ownSessions = new Set();

    // Per-session inactivity timers: sessionId -> timerHandle.
    const sessionTimers = new Map();

    function startTimer(sessionId, timeoutMs) {
      const existing = sessionTimers.get(sessionId);
      if (existing) {
        clearTimeout(existing);
        sessionTimers.delete(sessionId);
      }
      if (!(timeoutMs > 0)) return;
      const t = setTimeout(() => {
        sessionTimers.delete(sessionId);
        const claim = store.getClaim(sessionId);
        if (claim && typeof claim.node.send === "function") {
          claim.node.send([
            errorEnvelope("TIMEOUT", "Inactivity timeout", {
              event: "timeout",
              sessionId,
            }),
            null,
          ]);
        }
      }, timeoutMs);
      sessionTimers.set(sessionId, t);
    }

    /* ----------------------- bus subscriptions ----------------------- */

    const onLifecycle = (evt) => {
      if (store.getLifecycleClaim(evt.sessionId) !== node) {
        return;
      }
      switch (evt.event) {
        case "connecting":
          node.status({ fill: "yellow", shape: "dot", text: "connecting" });
          break;
        case "connected":
          node.status({ fill: "green", shape: "dot", text: "connected" });
          node.send([
            okEnvelope({
              event: "connected",
              sessionId: evt.sessionId,
              remoteHost: evt.remoteHost,
              remotePort: evt.remotePort,
              localPort: evt.localPort,
            }),
            null,
          ]);
          break;
        case "disconnected":
          node.status({ fill: "grey", shape: "ring", text: "disconnected" });
          node.send([
            okEnvelope({ event: "disconnected", sessionId: evt.sessionId }),
            null,
          ]);
          break;
        case "timeout":
          node.status({ fill: "red", shape: "ring", text: "timeout" });
          node.send([
            errorEnvelope("TIMEOUT", "Inactivity timeout", {
              event: "timeout",
              sessionId: evt.sessionId,
            }),
            null,
          ]);
          break;
        case "error":
          node.status({ fill: "red", shape: "dot", text: "error" });
          node.send([
            errorEnvelope(
              evt.errorCode || "TRANSPORT_ERROR",
              evt.errorText || "Transport error",
              { event: "error", sessionId: evt.sessionId }
            ),
            null,
          ]);
          break;
        default:
          break;
      }
    };

    const onData = (evt) => {
      const claim = store.getClaim(evt.sessionId);
      if (!claim || claim.node !== node) {
        return;
      }
      const rec = store.registry.get(evt.sessionId);
      const recMode = rec ? rec.mode : mode;
      store.registry.touch(evt.sessionId);
      store.deliverData(
        { sessionId: evt.sessionId, mode: recMode, chunk: evt.chunk },
        (env) => node.send([null, env])
      );
    };

    // Reset the inactivity timer on every inbound frame for sessions this
    // node owns, regardless of which node currently holds the data claim.
    const onDataForTimer = (evt) => {
      if (!ownSessions.has(evt.sessionId)) return;
      const rec = store.registry.get(evt.sessionId);
      if (rec && rec.timeoutMs > 0) {
        startTimer(evt.sessionId, rec.timeoutMs);
      }
    };

    // A send node emits this after a successful write to arm/re-arm the timer.
    const onTimeoutSet = (evt) => {
      if (!ownSessions.has(evt.sessionId)) return;
      startTimer(evt.sessionId, evt.timeoutMs);
    };

    store.globalBus.on("conn-lifecycle", onLifecycle);
    store.globalBus.on("conn-data", onData);
    store.globalBus.on("conn-data", onDataForTimer);
    store.globalBus.on("conn-timeout-set", onTimeoutSet);

    /* --------------------------- connecting -------------------------- */

    function doConnect(msg, send, done) {
      const localSend = send || ((m) => node.send(m));
      const localDone = done || (() => {});
      const m = msg || {};

      const host = (m.host || cfgHost || "").trim();
      const port = parseInt(m.port != null ? m.port : cfgPort, 10);

      if (!host || !port) {
        localSend([
          errorEnvelope(
            "CONNECT_INVALID",
            "connect requires host and port",
            { event: "error" }
          ),
          null,
        ]);
        return localDone();
      }

      let record;
      try {
        record = store.registry.create({
          sessionId: m.sessionId,
          kind: "tcp",
          remoteHost: host,
          remotePort: port,
          state: "connecting",
          mode: mode,
        });
      } catch (err) {
        localSend([
          errorEnvelope(
            err.code || "SESSION_ID_CONFLICT",
            err.message || "Session already exists",
            { event: "error", sessionId: m.sessionId }
          ),
          null,
        ]);
        return localDone();
      }

      const sessionId = record.sessionId;
      ownSessions.add(sessionId);

      const client = new TcpClient({ host, port, timeout });
      store.indexSession(sessionId, client);
      store.setLifecycleClaim(sessionId, node);
      store.setClaim(sessionId, node, waitFor);

      // Bridge transport events onto the shared bus.
      client.on("connecting", () => {
        store.registry.update(sessionId, { state: "connecting" });
        store.globalBus.emit("conn-lifecycle", { event: "connecting", sessionId });
      });
      client.on("connect", (info) => {
        store.registry.update(sessionId, {
          state: "connected",
          localPort: info.localPort,
        });
        store.globalBus.emit("conn-lifecycle", {
          event: "connected",
          sessionId,
          remoteHost: host,
          remotePort: port,
          localPort: info.localPort,
        });
      });
      client.on("data", (chunk) => {
        store.globalBus.emit("conn-data", { sessionId, chunk });
      });
      client.on("timeout", () => {
        store.globalBus.emit("conn-lifecycle", { event: "timeout", sessionId });
      });
      client.on("error", (err) => {
        store.globalBus.emit("conn-lifecycle", {
          event: "error",
          sessionId,
          errorCode: err.code === "SOCKET_NOT_CONNECTED"
            ? "SOCKET_NOT_CONNECTED"
            : "CONNECT_FAILED",
          errorText: err.message || "Connection attempt failed",
        });
      });
      client.on("close", () => {
        const t = sessionTimers.get(sessionId);
        if (t) {
          clearTimeout(t);
          sessionTimers.delete(sessionId);
        }
        store.registry.update(sessionId, { state: "disconnected" });
        store.globalBus.emit("conn-lifecycle", { event: "disconnected", sessionId });
        ownSessions.delete(sessionId);
        store.purgeSession(sessionId);
      });

      client.connect();

      // Immediate ack on the events output.
      localSend([
        okEnvelope({
          event: "connecting",
          sessionId,
          remoteHost: host,
          remotePort: port,
        }),
        null,
      ]);
      localDone();
    }

    node.on("input", (msg, send, done) => {
      doConnect(msg, send, done);
    });

    if (autoConnect && cfgHost && cfgPort) {
      // Connect shortly after deploy.
      setImmediate(() => doConnect({}, null, null));
    } else {
      node.status({ fill: "grey", shape: "ring", text: "idle" });
    }

    node.on("close", (removed, done) => {
      store.globalBus.off("conn-lifecycle", onLifecycle);
      store.globalBus.off("conn-data", onData);
      store.globalBus.off("conn-data", onDataForTimer);
      store.globalBus.off("conn-timeout-set", onTimeoutSet);
      // Tear down sessions this node created.
      for (const sessionId of Array.from(ownSessions)) {
        const t = sessionTimers.get(sessionId);
        if (t) {
          clearTimeout(t);
          sessionTimers.delete(sessionId);
        }
        const transport = store.transportForSession(sessionId);
        if (transport && typeof transport.destroy === "function") {
          transport.destroy();
        }
        store.purgeSession(sessionId);
      }
      ownSessions.clear();
      node.status({});
      done();
    });
  }

  RED.nodes.registerType("tcp-connect", TcpConnectNode);
};
