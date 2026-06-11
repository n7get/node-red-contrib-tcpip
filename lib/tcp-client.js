"use strict";

/**
 * tcp-client.js
 * -------------
 * RED-agnostic wrapper around a Node.js `net.Socket`. Manages the lifecycle
 * of a single outbound TCP/IPv4 connection and re-emits its activity as
 * high-level events:
 *
 *   "connecting" ()                       — connect attempt started
 *   "connect"    ({ localPort, remoteAddress, remotePort })
 *   "data"       (Buffer)                 — inbound bytes
 *   "close"      ({ hadError })           — socket fully closed
 *   "error"      (Error)                  — socket error (close usually follows)
 *
 * A `socketFactory` may be injected for unit testing; by default it uses the
 * Node core `net` module. The class never depends on RED.
 */

const net = require("net");
const EventEmitter = require("events");

class TcpClient extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.host       remote host (IPv4 address or name)
   * @param {number} options.port       remote port
   * @param {number} [options.timeout]  inactivity timeout in ms (0 = none)
   * @param {function} [options.socketFactory] returns a net.Socket-like object
   */
  constructor(options) {
    super();
    const opts = options || {};
    this.host = opts.host;
    this.port = opts.port;
    this.timeout = opts.timeout || 0;
    this._socketFactory = opts.socketFactory || (() => new net.Socket());
    this.socket = null;
    this.connected = false;
    this._closing = false;
  }

  /**
   * Open the TCP connection. Emits "connecting" synchronously, then "connect"
   * on success or "error"/"close" on failure.
   */
  connect() {
    if (this.socket) {
      return;
    }
    this._closing = false;
    const socket = this._socketFactory();
    this.socket = socket;

    // Force IPv4 per requirements.
    const connectOpts = { host: this.host, port: this.port, family: 4 };

    socket.on("connect", () => {
      this.connected = true;
      if (this.timeout > 0 && typeof socket.setTimeout === "function") {
        socket.setTimeout(this.timeout);
      }
      this.emit("connect", {
        localPort: socket.localPort,
        remoteAddress: socket.remoteAddress,
        remotePort: socket.remotePort,
      });
    });

    socket.on("data", (chunk) => {
      this.emit("data", chunk);
    });

    socket.on("timeout", () => {
      // Surface as an error; consumer decides whether to close.
      this.emit("timeout");
    });

    socket.on("error", (err) => {
      this.emit("error", err);
    });

    socket.on("close", (hadError) => {
      this.connected = false;
      this.socket = null;
      this.emit("close", { hadError: !!hadError });
    });

    try {
      this.emit("connecting");
      socket.connect(connectOpts);
    } catch (err) {
      this.emit("error", err);
    }
  }

  /**
   * Write data to the socket.
   * @param {Buffer|string} data
   * @returns {boolean} false if the kernel buffer is full (apply backpressure).
   * @throws {Error} if the socket is not connected.
   */
  write(data) {
    if (!this.socket || !this.connected) {
      const err = new Error("Socket is not connected");
      err.code = "SOCKET_NOT_CONNECTED";
      throw err;
    }
    return this.socket.write(data);
  }

  /**
   * Gracefully close the connection (FIN). A "close" event follows.
   */
  end() {
    this._closing = true;
    if (this.socket) {
      this.socket.end();
    }
  }

  /**
   * Forcibly destroy the socket.
   */
  destroy() {
    this._closing = true;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
    }
  }
}

module.exports = TcpClient;
