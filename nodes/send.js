"use strict";

/**
 * tcp-send node
 * -------------
 * Sends data on an existing TCP session identified by `msg.sessionId`, and
 * claims the session's data output so the response is routed back to this
 * node (output 2). A "sent" acknowledgement is emitted on output 1.
 *
 * Accepts `msg.payload` as a String, a Buffer, or an Array of String/Buffer
 * items (each array item is written separately). No automatic encoding is
 * applied — strings are written as-is.
 */

const store = require("../lib/runtime-store");
const { okEnvelope, errorEnvelope, makeMessageId } = require("../lib/message-utils");

module.exports = function (RED) {
  function TcpSendNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    const waitForStr = (config.waitFor || "").trim();
    let nodeWaitFor = null;
    if (waitForStr) {
      try {
        nodeWaitFor = new RegExp(waitForStr);
      } catch (err) {
        node.status({ fill: "red", shape: "ring", text: "bad waitFor regex" });
      }
    }

    // Deliver responses for sessions this node currently claims.
    const onData = (evt) => {
      const claim = store.getClaim(evt.sessionId);
      if (!claim || claim.node !== node) {
        return;
      }
      const rec = store.registry.get(evt.sessionId);
      const recMode = rec ? rec.mode : "binary";
      store.registry.touch(evt.sessionId);
      store.deliverData(
        { sessionId: evt.sessionId, mode: recMode, chunk: evt.chunk },
        (env) => node.send([null, env])
      );
    };
    store.globalBus.on("conn-data", onData);

    node.on("input", (msg, send, done) => {
      const localSend = send || ((m) => node.send(m));
      const localDone = done || (() => {});
      const sessionId = msg.sessionId;

      if (!sessionId || !store.registry.has(sessionId)) {
        localSend([
          errorEnvelope("SESSION_NOT_FOUND", "Session not found", {
            event: "error",
            sessionId: sessionId || null,
          }),
          null,
        ]);
        return localDone();
      }

      const record = store.registry.get(sessionId);
      if (record.state !== "connected") {
        localSend([
          errorEnvelope("SESSION_NOT_CONNECTED", "Session is not connected", {
            event: "error",
            sessionId,
          }),
          null,
        ]);
        return localDone();
      }

      // Normalise payload to an array of items.
      let items;
      if (Array.isArray(msg.payload)) {
        items = msg.payload;
      } else {
        items = [msg.payload];
      }

      for (const item of items) {
        if (typeof item !== "string" && !Buffer.isBuffer(item)) {
          localSend([
            errorEnvelope(
              "PAYLOAD_INVALID",
              "payload items must be string or Buffer",
              { event: "error", sessionId }
            ),
            null,
          ]);
          return localDone();
        }
      }

      const transport = store.transportForSession(sessionId);
      if (!transport) {
        localSend([
          errorEnvelope("SOCKET_NOT_CONNECTED", "Socket is not connected", {
            event: "error",
            sessionId,
          }),
          null,
        ]);
        return localDone();
      }

      // Re-claim the data output for this session. Flush any pending waitFor
      // buffer to the previous owner before transferring.
      const prev = store.getClaim(sessionId);
      if (prev && prev.node !== node) {
        const pending = store.getWaitForBuffer(sessionId);
        if (pending.length && typeof prev.node.send === "function") {
          prev.node.send([
            null,
            okEnvelope({ event: "data", sessionId, payload: pending.slice() }),
          ]);
        }
        store.setWaitForBuffer(sessionId, []);
      }
      const effectiveWaitFor =
        nodeWaitFor || (prev ? prev.waitFor : null);
      store.setClaim(sessionId, node, effectiveWaitFor);

      const messageId = makeMessageId("msg");
      try {
        for (const item of items) {
          transport.write(item);
        }
      } catch (err) {
        localSend([
          errorEnvelope(
            err.code || "SOCKET_NOT_CONNECTED",
            err.message || "Socket is not connected",
            { event: "error", sessionId }
          ),
          null,
        ]);
        return localDone();
      }

      store.registry.touch(sessionId);
      localSend([
        okEnvelope({
          event: "sent",
          sessionId,
          messageId,
          chunkCount: items.length,
        }),
        null,
      ]);
      localDone();
    });

    node.on("close", (removed, done) => {
      store.globalBus.off("conn-data", onData);
      node.status({});
      done();
    });
  }

  RED.nodes.registerType("tcp-send", TcpSendNode);
};
