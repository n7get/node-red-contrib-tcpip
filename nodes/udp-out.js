"use strict";

/**
 * udp-out node
 * ------------
 * Sends UDP/IPv4 datagrams. Supports unicast, multicast and broadcast
 * destinations. The destination host/port come from the node config but can
 * be overridden per message via `msg.host` / `msg.port`. `msg.payload` may be
 * a String or a Buffer.
 *
 * A send-only socket is created on deploy and tracked with a sessionId. The
 * single output emits a "sent" acknowledgement or an error envelope.
 */

const UdpSocket = require("../lib/udp-socket");
const store = require("../lib/runtime-store");
const { okEnvelope, errorEnvelope } = require("../lib/message-utils");

module.exports = function (RED) {
  function UdpOutNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    const cfgHost = (config.host || "").trim();
    const cfgPort = parseInt(config.port, 10);
    const broadcast = !!config.broadcast;
    const multicastTtl = parseInt(config.multicastTtl, 10) || null;

    const udp = new UdpSocket({ broadcast, multicastTtl });

    const record = store.registry.create({
      kind: "udp",
      remoteHost: cfgHost || null,
      remotePort: cfgPort || null,
      state: "connected",
      mode: "binary",
      metadata: { broadcast, multicast: !!multicastTtl },
    });
    const sessionId = record.sessionId;
    store.indexSession(sessionId, udp);

    udp.on("error", (err) => {
      node.status({ fill: "red", shape: "dot", text: "error" });
      node.send(
        errorEnvelope("UDP_ERROR", err.message || "UDP socket error", {
          event: "error",
          sessionId,
        })
      );
    });

    node.status({ fill: "grey", shape: "ring", text: "ready" });

    node.on("input", (msg, send, done) => {
      const localSend = send || ((m) => node.send(m));
      const localDone = done || (() => {});

      const host = (msg.host || cfgHost || "").trim();
      const port = parseInt(msg.port != null ? msg.port : cfgPort, 10);

      if (!host || !port) {
        localSend(
          errorEnvelope("SEND_INVALID", "udp-out requires host and port", {
            event: "error",
            sessionId,
          })
        );
        return localDone();
      }

      const payload = msg.payload;
      if (typeof payload !== "string" && !Buffer.isBuffer(payload)) {
        localSend(
          errorEnvelope(
            "PAYLOAD_INVALID",
            "payload must be string or Buffer",
            { event: "error", sessionId }
          )
        );
        return localDone();
      }

      const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
      udp.send(data, port, host, (err) => {
        if (err) {
          localSend(
            errorEnvelope("UDP_SEND_FAILED", err.message || "UDP send failed", {
              event: "error",
              sessionId,
            })
          );
          return localDone();
        }
        store.registry.touch(sessionId);
        node.status({
          fill: "green",
          shape: "dot",
          text: `sent ${data.length}b`,
        });
        localSend(
          okEnvelope({
            event: "sent",
            sessionId,
            host,
            port,
            bytes: data.length,
          })
        );
        localDone();
      });
    });

    node.on("close", (removed, done) => {
      udp.close();
      store.purgeSession(sessionId);
      node.status({});
      done();
    });
  }

  RED.nodes.registerType("udp-out", UdpOutNode);
};
