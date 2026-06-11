"use strict";

/**
 * FakeTcpClient — a synchronous, controllable stand-in for TcpClient.
 *
 * Behaviour:
 *   - connect() emits "connecting" immediately (synchronous, matching the
 *     real client).  Tests call simulateConnect() / simulateData() / etc.
 *     to fire subsequent events when the test is ready.
 *   - write() records items in this._written; throws SOCKET_NOT_CONNECTED
 *     when this.connected is false.
 *   - end() / destroy() mark disconnected and emit "close".
 *
 * Usage in tests:
 *   const { FakeTcpClient, lastCreated } = require("../helpers/fake-tcp-client");
 *   // proxyquire the node module with FakeTcpClient as the replacement.
 *   // After the node calls doConnect(), lastCreated() returns the instance.
 */

const EventEmitter = require("events");

let _last = null;

class FakeTcpClient extends EventEmitter {
  constructor(opts) {
    super();
    this._opts = opts || {};
    this.connected = false;
    this._written = [];
    _last = this;
  }

  connect() {
    // Emit "connecting" synchronously — identical to the real TcpClient.
    this.emit("connecting");
    // "connect" is NOT emitted here; tests drive it via simulateConnect().
  }

  write(data) {
    if (!this.connected) {
      const err = new Error("Socket is not connected");
      err.code = "SOCKET_NOT_CONNECTED";
      throw err;
    }
    this._written.push(data);
    return true;
  }

  end() {
    this.connected = false;
    this.emit("close", { hadError: false });
  }

  destroy() {
    this.connected = false;
    this.emit("close", { hadError: false });
  }

  // ---- test helpers ----

  simulateConnect(localPort = 54321) {
    this.connected = true;
    this.emit("connect", { localPort });
  }

  simulateData(chunk) {
    this.emit("data", Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  simulateError(code = "ECONNREFUSED", message = "Connection refused") {
    const err = new Error(message);
    err.code = code;
    this.emit("error", err);
  }

  simulateTimeout() {
    this.emit("timeout");
  }

  simulateClose() {
    this.connected = false;
    this.emit("close", { hadError: false });
  }
}

/** Return the most-recently constructed FakeTcpClient instance. */
function lastCreated() {
  return _last;
}

module.exports = { FakeTcpClient, lastCreated };
