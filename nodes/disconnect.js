"use strict";

/**
 * tcp-disconnect node
 * -------------------
 * Closes an existing TCP session identified by `msg.sessionId`. The actual
 * "disconnected" lifecycle event is emitted by the owning `connect` node when
 * the socket close completes; this node emits an immediate "disconnecting"
 * acknowledgement (or an error envelope) on its single output.
 */

const store = require("../lib/runtime-store");
const { okEnvelope, errorEnvelope } = require("../lib/message-utils");

module.exports = function (RED) {
  function TcpDisconnectNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.on("input", (msg, send, done) => {
      const localSend = send || ((m) => node.send(m));
      const localDone = done || (() => {});
      const sessionId = msg.sessionId;

      if (!sessionId || !store.registry.has(sessionId)) {
        localSend(
          errorEnvelope("SESSION_NOT_FOUND", "Session not found", {
            event: "error",
            sessionId: sessionId || null,
          })
        );
        return localDone();
      }

      const transport = store.transportForSession(sessionId);
      if (transport && typeof transport.end === "function") {
        transport.end();
      } else if (transport && typeof transport.close === "function") {
        transport.close();
      }

      store.registry.update(sessionId, { state: "disconnecting" });
      localSend(
        okEnvelope({ event: "disconnecting", sessionId })
      );
      localDone();
    });

    node.on("close", (removed, done) => {
      node.status({});
      done();
    });
  }

  RED.nodes.registerType("tcp-disconnect", TcpDisconnectNode);
};
