"use strict";

/**
 * tcp-listen node
 * ---------------
 * Listens for inbound TCP/IPv4 connections, allocates a sessionId for each,
 * and emits lifecycle events on output 1 (events) and inbound data on
 * output 2 (data).
 *
 * The node owns the transport and lifecycle claim for all sessions it creates.
 * The `send` and `disconnect` nodes can act on any accepted session using
 * only its sessionId. To reject an incoming connection, wire the `connected`
 * event output into a `disconnect` node (optionally via a function node that
 * filters on remoteHost/remotePort).
 *
 * On close (redeploy/shutdown), all sessions originated by this node are
 * torn down — active connections are destroyed and purged from the store.
 *
 * Note: the OS TCP stack completes the three-way handshake before this node
 * receives the connection. Application-level rejection (via disconnect) sends
 * a TCP RST to the client.
 */

const TcpServer = require("../lib/tcp-server");
const store = require("../lib/runtime-store");
const { okEnvelope, errorEnvelope } = require("../lib/message-utils");

module.exports = function (RED) {
  function TcpListenNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    const cfgHost = (config.host || "0.0.0.0").trim();
    const cfgPort = parseInt(config.port, 10);
    const mode = config.mode === "line" ? "line" : "binary";
    const timeout = parseInt(config.timeout, 10) || 0;
    const waitForStr = (config.waitFor || "").trim();

    let waitFor = null;
    if (waitForStr) {
      try {
        waitFor = new RegExp(waitForStr);
      } catch (err) {
        node.status({ fill: "red", shape: "ring", text: "bad waitFor regex" });
      }
    }

    if (!cfgPort) {
      node.status({ fill: "red", shape: "ring", text: "port required" });
      return;
    }

    // All sessions created by this node.
    const ownSessions = new Set();
    let closing = false;

    /* ----------------------- bus subscriptions ----------------------- */

    const onLifecycle = (evt) => {
      if (store.getLifecycleClaim(evt.sessionId) !== node) {
        return;
      }
      switch (evt.event) {
        case "connected":
          node.send([
            okEnvelope({
              event: "connected",
              sessionId: evt.sessionId,
              remoteHost: evt.remoteHost,
              remotePort: evt.remotePort,
              localHost: evt.localHost,
              localPort: evt.localPort,
            }),
            null,
          ]);
          break;
        case "disconnected":
          node.send([
            okEnvelope({ event: "disconnected", sessionId: evt.sessionId }),
            null,
          ]);
          break;
        case "timeout":
          node.send([
            errorEnvelope("TIMEOUT", "Inactivity timeout", {
              event: "timeout",
              sessionId: evt.sessionId,
            }),
            null,
          ]);
          break;
        case "error":
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

    store.globalBus.on("conn-lifecycle", onLifecycle);
    store.globalBus.on("conn-data", onData);

    /* ----------------------- server setup ----------------------- */

    const server = new TcpServer({ host: cfgHost, port: cfgPort });

    server.on("listening", (info) => {
      if (closing) {
        return;
      }
      node.status({ fill: "green", shape: "dot", text: `listening :${info.localPort}` });
      node.send([
        okEnvelope({
          event: "listening",
          localHost: info.localHost,
          localPort: info.localPort,
        }),
        null,
      ]);
    });

    server.on("connection", (socket, info) => {
      if (closing) {
        socket.destroy();
        return;
      }

      let record;
      try {
        record = store.registry.create({
          kind: "tcp",
          remoteHost: info.remoteHost,
          remotePort: info.remotePort,
          localHost: info.localHost,
          localPort: info.localPort,
          state: "connected",
          mode,
        });
      } catch (err) {
        socket.destroy();
        return;
      }

      const sessionId = record.sessionId;
      ownSessions.add(sessionId);
      store.indexSession(sessionId, socket);
      store.setLifecycleClaim(sessionId, node);
      store.setClaim(sessionId, node, waitFor);

      if (timeout > 0 && typeof socket.setTimeout === "function") {
        socket.setTimeout(timeout);
      }

      socket.on("data", (chunk) => {
        store.globalBus.emit("conn-data", { sessionId, chunk });
      });

      socket.on("timeout", () => {
        store.globalBus.emit("conn-lifecycle", { event: "timeout", sessionId });
        socket.destroy();
      });

      socket.on("error", (err) => {
        store.globalBus.emit("conn-lifecycle", {
          event: "error",
          sessionId,
          errorCode: err.code || "TRANSPORT_ERROR",
          errorText: err.message || "Transport error",
        });
      });

      socket.on("close", () => {
        ownSessions.delete(sessionId);
        store.purgeSession(sessionId);
        if (!closing) {
          store.globalBus.emit("conn-lifecycle", { event: "disconnected", sessionId });
        }
      });

      store.globalBus.emit("conn-lifecycle", {
        event: "connected",
        sessionId,
        remoteHost: info.remoteHost,
        remotePort: info.remotePort,
        localHost: info.localHost,
        localPort: info.localPort,
      });
    });

    server.on("error", (err) => {
      if (closing) {
        return;
      }
      node.status({ fill: "red", shape: "dot", text: err.code || "error" });
      node.send([
        errorEnvelope(err.code || "SERVER_ERROR", err.message || "Server error", {
          event: "error",
        }),
        null,
      ]);
    });

    server.on("close", () => {
      if (closing) {
        return;
      }
      node.status({ fill: "grey", shape: "ring", text: "closed" });
      node.send([okEnvelope({ event: "closed" }), null]);
    });

    server.listen();

    /* ----------------------- cleanup ----------------------- */

    node.on("close", (removed, done) => {
      closing = true;
      store.globalBus.off("conn-lifecycle", onLifecycle);
      store.globalBus.off("conn-data", onData);
      server.close();
      for (const sessionId of Array.from(ownSessions)) {
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

  RED.nodes.registerType("tcp-listen", TcpListenNode);
};
