"use strict";

/**
 * FakeUdpSocket — a synchronous, controllable stand-in for UdpSocket.
 *
 * Behaviour:
 *   - bind() / open() are no-ops; tests call simulateListening() when ready.
 *   - send() records the call in this._lastSend and immediately invokes the
 *     callback with this._sendErr (null by default to simulate success).
 *   - close() marks the socket as closed and emits "close".
 *
 * Usage in tests:
 *   const { FakeUdpSocket, lastCreated } = require("../helpers/fake-udp-socket");
 *   // proxyquire the node module with FakeUdpSocket as the replacement.
 *   // After the node constructor runs, lastCreated() returns the instance.
 */

const EventEmitter = require("events");

let _last = null;

class FakeUdpSocket extends EventEmitter {
  constructor(opts) {
    super();
    this._opts = opts || {};
    this.bound = false;
    this._closed = false;
    this._sendErr = null; // set to an Error to simulate send failure
    this._lastSend = null;
    _last = this;
  }

  bind() {
    // No-op — tests call simulateListening().
  }

  open() {
    // No-op — tests call simulateListening().
  }

  send(data, port, host, callback) {
    this._lastSend = { data, port, host };
    const cb = callback || (() => {});
    cb(this._sendErr || null);
  }

  close() {
    if (!this._closed) {
      this._closed = true;
      this.emit("close");
    }
  }

  // ---- test helpers ----

  simulateListening(port, address) {
    this.bound = true;
    this.emit("listening", {
      address: address || "0.0.0.0",
      port: port || this._opts.port || 0,
    });
  }

  simulateMessage(buf, rinfo) {
    this.emit(
      "message",
      Buffer.isBuffer(buf) ? buf : Buffer.from(buf),
      rinfo || { address: "1.2.3.4", port: 5000 }
    );
  }

  simulateError(message = "UDP error") {
    const err = new Error(message);
    this.emit("error", err);
  }
}

/** Return the most-recently constructed FakeUdpSocket instance. */
function lastCreated() {
  return _last;
}

module.exports = { FakeUdpSocket, lastCreated };
