"use strict";

/**
 * Minimal Node-RED RED mock for unit testing.
 *
 * Creates a RED object whose `nodes.createNode` wires up the standard
 * node-API surface (send / status / on / error) as simple in-memory
 * recorders, and whose `nodes.registerType` stores the constructor so
 * tests can instantiate nodes directly.
 */
function createMockRED() {
  const nodeTypes = {};

  const RED = {
    nodes: {
      createNode(node, config) {
        node._sent = [];
        node._statuses = [];
        node._handlers = {};
        node.id =
          (config && config.id) ||
          "node-" + Math.random().toString(36).slice(2);

        node.send = function (msg) {
          this._sent.push(msg);
        };
        node.status = function (s) {
          this._statuses.push(s);
        };
        node.on = function (event, fn) {
          this._handlers[event] = fn;
          return this;
        };
        node.error = function () {};
      },

      registerType(name, Constructor) {
        nodeTypes[name] = Constructor;
      },
    },

    _types: nodeTypes,
  };

  return RED;
}

module.exports = { createMockRED };
