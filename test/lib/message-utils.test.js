"use strict";

const assert = require("assert");
const {
  nowTimestamp,
  makeMessageId,
  okEnvelope,
  errorEnvelope,
} = require("../../lib/message-utils");

describe("message-utils", () => {
  // ---- nowTimestamp ----

  describe("nowTimestamp()", () => {
    it("returns a parseable ISO-8601 string", () => {
      const ts = nowTimestamp();
      assert.ok(!isNaN(Date.parse(ts)), "should be a valid date string");
    });

    it("is within a reasonable window of the current time", () => {
      const before = Date.now();
      const ts = nowTimestamp();
      const after = Date.now();
      const parsed = new Date(ts).getTime();
      assert.ok(parsed >= before && parsed <= after);
    });
  });

  // ---- makeMessageId ----

  describe("makeMessageId()", () => {
    it("uses 'id' as the default prefix", () => {
      assert.ok(makeMessageId().startsWith("id-"));
    });

    it("uses the supplied prefix", () => {
      assert.ok(makeMessageId("sess").startsWith("sess-"));
    });

    it("generates unique values across many calls", () => {
      const ids = new Set(Array.from({ length: 200 }, () => makeMessageId("x")));
      assert.strictEqual(ids.size, 200);
    });
  });

  // ---- okEnvelope ----

  describe("okEnvelope()", () => {
    it("sets status to 'ok'", () => {
      assert.strictEqual(okEnvelope().status, "ok");
    });

    it("includes a string timestamp", () => {
      const env = okEnvelope();
      assert.strictEqual(typeof env.timestamp, "string");
      assert.ok(!isNaN(Date.parse(env.timestamp)));
    });

    it("merges extra fields", () => {
      const env = okEnvelope({ event: "connected", sessionId: "s1" });
      assert.strictEqual(env.event, "connected");
      assert.strictEqual(env.sessionId, "s1");
    });

    it("works with no arguments", () => {
      assert.doesNotThrow(() => okEnvelope());
    });
  });

  // ---- errorEnvelope ----

  describe("errorEnvelope()", () => {
    it("sets status to 'error'", () => {
      assert.strictEqual(errorEnvelope("ERR", "msg").status, "error");
    });

    it("records errorCode and errorText", () => {
      const env = errorEnvelope("SESSION_NOT_FOUND", "Session missing");
      assert.strictEqual(env.errorCode, "SESSION_NOT_FOUND");
      assert.strictEqual(env.errorText, "Session missing");
    });

    it("includes a string timestamp", () => {
      const env = errorEnvelope("E", "t");
      assert.strictEqual(typeof env.timestamp, "string");
    });

    it("merges extra fields", () => {
      const env = errorEnvelope("E", "t", { sessionId: "s2", event: "error" });
      assert.strictEqual(env.sessionId, "s2");
      assert.strictEqual(env.event, "error");
    });
  });
});
