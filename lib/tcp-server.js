"use strict";

/**
 * tcp-server.js
 * -------------
 * RED-agnostic wrapper around a Node.js `net.Server`. Manages the lifecycle
 * of a TCP/IPv4 server and re-emits its activity as high-level events:
 *
 *   "listening"  ({ localHost, localPort })   — server successfully bound
 *   "connection" (socket, { remoteHost, remotePort, localHost, localPort })
 *   "error"      (Error)                      — server-level error
 *   "close"      ()                           — server fully stopped
 *
 * A `serverFactory` may be injected for unit testing; by default it uses the
 * Node core `net` module. The class never depends on RED.
 */

const net = require("net");
const EventEmitter = require("events");

class TcpServer extends EventEmitter {
  /**
   * @param {object} options
   * @param {string}   [options.host]          bind address (default: "0.0.0.0")
   * @param {number}   options.port            listen port
   * @param {function} [options.serverFactory] returns a net.Server-like object
   */
  constructor(options) {
    super();
    const opts = options || {};
    this.host = opts.host || "0.0.0.0";
    this.port = opts.port;
    this._serverFactory = opts.serverFactory || (() => net.createServer());
    this.server = null;
  }

  /**
   * Start listening. Emits "listening" on success or "error" on failure.
   * Idempotent — subsequent calls while already listening are ignored.
   */
  listen() {
    if (this.server) {
      return;
    }

    const server = this._serverFactory();
    this.server = server;

    server.on("connection", (socket) => {
      this.emit("connection", socket, {
        remoteHost: socket.remoteAddress,
        remotePort: socket.remotePort,
        localHost: socket.localAddress,
        localPort: socket.localPort,
      });
    });

    server.on("error", (err) => {
      this.emit("error", err);
    });

    server.on("close", () => {
      this.server = null;
      this.emit("close");
    });

    server.listen(this.port, this.host, () => {
      const addr = server.address();
      this.emit("listening", {
        localHost: addr.address,
        localPort: addr.port,
      });
    });
  }

  /**
   * Stop accepting new connections. Existing connections remain open until
   * closed by the caller. Emits "close" when the server has fully stopped.
   * Idempotent — safe to call when already stopped.
   */
  close() {
    if (!this.server) {
      return;
    }
    this.server.close();
  }
}

module.exports = TcpServer;
