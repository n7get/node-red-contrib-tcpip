"use strict";

/**
 * udp-in node
 * -----------
 * Binds a UDP/IPv4 socket on deploy and emits received datagrams. Supports
 * joining a multicast group and (via reuseAddr) shared binding. A sessionId
 * is allocated for the listening socket so it can be tracked and torn down.
 *
 * Output 1 (events): listening / error envelopes.
 * Output 2 (data)  : one message per datagram, payload is a Buffer (binary)
 *                    or a String (line/utf8 mode), with `rinfo` describing the
 *                    sender.
 */

const UdpSocket = require("../lib/udp-socket");
const store = require("../lib/runtime-store");
const { okEnvelope, errorEnvelope } = require("../lib/message-utils");

module.exports = function (RED) {
  function UdpInNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    const port = parseInt(config.port, 10);
    const address = (config.address || "").trim() || undefined;
    const multicastGroup = (config.multicastGroup || "").trim() || null;
    const mode = config.mode === "utf8" ? "utf8" : "binary";
    const reuseAddr = config.reuseAddr !== false;

    if (!port) {
      node.status({ fill: "red", shape: "ring", text: "missing port" });
      return;
    }

    let sessionId = null;
    let udp = null;

    function start() {
      udp = new UdpSocket({
        port,
        address,
        multicastGroup,
        reuseAddr,
      });

      const record = store.registry.create({
        kind: "udp",
        localPort: port,
        localHost: address || null,
        state: "connecting",
        mode,
        metadata: { multicastGroup },
      });
      sessionId = record.sessionId;
      store.indexSession(sessionId, udp);

      udp.on("listening", (info) => {
        store.registry.update(sessionId, { state: "connected" });
        node.status({
          fill: "green",
          shape: "dot",
          text: `listening :${info.port || port}`,
        });
        node.send([
          okEnvelope({
            event: "listening",
            sessionId,
            address: info.address,
            port: info.port,
            multicastGroup,
          }),
          null,
        ]);
      });

      udp.on("message", (buf, rinfo) => {
        store.registry.touch(sessionId);
        const payload = mode === "utf8" ? buf.toString("utf8") : buf;
        node.send([
          null,
          okEnvelope({
            event: "data",
            sessionId,
            payload,
            rinfo,
          }),
        ]);
      });

      udp.on("error", (err) => {
        node.status({ fill: "red", shape: "dot", text: "error" });
        node.send([
          errorEnvelope("UDP_ERROR", err.message || "UDP socket error", {
            event: "error",
            sessionId,
          }),
          null,
        ]);
      });

      udp.on("close", () => {
        node.status({ fill: "grey", shape: "ring", text: "closed" });
      });

      udp.bind();
    }

    start();

    node.on("close", (removed, done) => {
      if (udp) {
        udp.close();
      }
      if (sessionId) {
        store.purgeSession(sessionId);
      }
      node.status({});
      done();
    });
  }

  RED.nodes.registerType("udp-in", UdpInNode);
};
