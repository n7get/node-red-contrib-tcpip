"use strict";

/**
 * udp-socket.js
 * -------------
 * RED-agnostic wrapper around a Node.js `dgram` socket. Supports both
 * receiving (bind + optional multicast join) and sending (unicast,
 * multicast, broadcast) of UDP/IPv4 datagrams.
 *
 * Events:
 *   "listening" ({ address, port })
 *   "message"   (Buffer, rinfo)
 *   "close"     ()
 *   "error"     (Error)
 *
 * A `dgramFactory` may be injected for unit testing.
 */

const dgram = require("dgram");
const EventEmitter = require("events");

class UdpSocket extends EventEmitter {
  /**
   * @param {object} options
   * @param {number} [options.port]            local port to bind (udp-in)
   * @param {string} [options.address]         local address to bind
   * @param {string} [options.multicastGroup]  group to join on bind
   * @param {boolean} [options.broadcast]      enable SO_BROADCAST
   * @param {boolean} [options.reuseAddr]      enable SO_REUSEADDR (default true)
   * @param {number} [options.multicastTtl]    TTL for outgoing multicast
   * @param {function} [options.dgramFactory]  returns a dgram.Socket-like obj
   */
  constructor(options) {
    super();
    const opts = options || {};
    this.port = opts.port;
    this.address = opts.address || undefined;
    this.multicastGroup = opts.multicastGroup || null;
    this.broadcast = !!opts.broadcast;
    this.reuseAddr = opts.reuseAddr !== false;
    this.multicastTtl = opts.multicastTtl || null;
    this._dgramFactory =
      opts.dgramFactory ||
      (() => dgram.createSocket({ type: "udp4", reuseAddr: this.reuseAddr }));
    this.socket = null;
    this.bound = false;
  }

  /**
   * Create the dgram socket and wire its events. Does not bind by itself —
   * call `bind()` for udp-in or `open()` for send-only udp-out.
   * @private
   */
  _ensureSocket() {
    if (this.socket) {
      return this.socket;
    }
    const socket = this._dgramFactory();
    this.socket = socket;

    socket.on("message", (msg, rinfo) => {
      this.emit("message", msg, rinfo);
    });
    socket.on("error", (err) => {
      this.emit("error", err);
    });
    socket.on("close", () => {
      this.bound = false;
      this.socket = null;
      this.emit("close");
    });
    return socket;
  }

  /**
   * Create a send-only socket (no bind to a specific port). Enables broadcast
   * if configured. Emits "listening" once ready.
   */
  open() {
    const socket = this._ensureSocket();
    // Bind to an ephemeral port so we can set options and send.
    socket.bind(() => {
      this._applySendOptions();
      this.bound = true;
      const addr = socket.address ? socket.address() : {};
      this.emit("listening", { address: addr.address, port: addr.port });
    });
  }

  /**
   * Bind to the configured port/address for receiving. Joins the multicast
   * group if one was configured. Emits "listening" once bound.
   */
  bind() {
    const socket = this._ensureSocket();
    socket.bind(this.port, this.address, () => {
      this.bound = true;
      this._applySendOptions();
      if (this.multicastGroup) {
        try {
          socket.addMembership(this.multicastGroup);
        } catch (err) {
          this.emit("error", err);
        }
      }
      const addr = socket.address ? socket.address() : {};
      this.emit("listening", { address: addr.address, port: addr.port });
    });
  }

  /** @private */
  _applySendOptions() {
    if (!this.socket) {
      return;
    }
    if (this.broadcast && typeof this.socket.setBroadcast === "function") {
      this.socket.setBroadcast(true);
    }
    if (
      this.multicastTtl &&
      typeof this.socket.setMulticastTTL === "function"
    ) {
      this.socket.setMulticastTTL(this.multicastTtl);
    }
  }

  /**
   * Send a datagram.
   * @param {Buffer|string} data
   * @param {number} port destination port
   * @param {string} host destination host (unicast/multicast/broadcast addr)
   * @param {function(Error=)} [callback]
   */
  send(data, port, host, callback) {
    const socket = this._ensureSocket();
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    const done = callback || (() => {});
    const doSend = () => {
      this._applySendOptions();
      socket.send(buf, 0, buf.length, port, host, done);
    };
    if (this.bound) {
      doSend();
    } else {
      // Bind to ephemeral port first, then send.
      socket.bind(() => {
        this.bound = true;
        doSend();
      });
    }
  }

  /**
   * Leave a multicast group (best effort) and close the socket.
   */
  close() {
    if (this.socket) {
      if (this.multicastGroup) {
        try {
          this.socket.dropMembership(this.multicastGroup);
        } catch (err) {
          // ignore — socket may already be closing
        }
      }
      try {
        this.socket.close();
      } catch (err) {
        // ignore
      }
    }
  }
}

module.exports = UdpSocket;
