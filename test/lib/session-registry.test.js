"use strict";

const assert = require("assert");
const SessionRegistry = require("../../lib/session-registry");

describe("SessionRegistry", () => {
  let registry;

  beforeEach(() => {
    registry = new SessionRegistry();
  });

  // ---- create ----

  describe("create()", () => {
    it("returns a copy with an auto-generated sessionId when none is supplied", () => {
      const rec = registry.create({ kind: "tcp" });
      assert.ok(typeof rec.sessionId === "string" && rec.sessionId.length > 0);
      assert.strictEqual(rec.kind, "tcp");
    });

    it("honours a caller-supplied sessionId", () => {
      const rec = registry.create({ sessionId: "my-id", kind: "udp" });
      assert.strictEqual(rec.sessionId, "my-id");
    });

    it("throws SESSION_ID_CONFLICT when the same id is created twice", () => {
      registry.create({ sessionId: "dup" });
      let threw = false;
      try {
        registry.create({ sessionId: "dup" });
      } catch (err) {
        threw = true;
        assert.strictEqual(err.code, "SESSION_ID_CONFLICT");
      }
      assert.ok(threw, "expected an error to be thrown");
    });

    it("applies sensible defaults for omitted fields", () => {
      const rec = registry.create({});
      assert.strictEqual(rec.kind, "tcp");
      assert.strictEqual(rec.state, "connecting");
      assert.strictEqual(rec.mode, "binary");
      assert.strictEqual(rec.localHost, null);
      assert.strictEqual(rec.remoteHost, null);
    });

    it("sets createdAt, updatedAt and lastActivityAt timestamps", () => {
      const before = Date.now();
      const rec = registry.create({});
      const after = Date.now();
      for (const field of ["createdAt", "updatedAt", "lastActivityAt"]) {
        const t = new Date(rec[field]).getTime();
        assert.ok(t >= before && t <= after, `${field} should be within bounds`);
      }
    });

    it("returns a shallow copy — mutations do not affect the stored record", () => {
      const rec = registry.create({ sessionId: "imm" });
      rec.state = "MUTATED";
      assert.strictEqual(registry.get("imm").state, "connecting");
    });
  });

  // ---- get ----

  describe("get()", () => {
    it("returns null for an unknown id", () => {
      assert.strictEqual(registry.get("no-such-id"), null);
    });

    it("returns a copy with the correct fields", () => {
      registry.create({ sessionId: "g1", kind: "udp", state: "connected" });
      const rec = registry.get("g1");
      assert.strictEqual(rec.sessionId, "g1");
      assert.strictEqual(rec.kind, "udp");
      assert.strictEqual(rec.state, "connected");
    });

    it("returns a copy — mutations do not affect the stored record", () => {
      registry.create({ sessionId: "g2" });
      registry.get("g2").state = "MUTATED";
      assert.strictEqual(registry.get("g2").state, "connecting");
    });
  });

  // ---- has ----

  describe("has()", () => {
    it("returns false for an unknown id", () => {
      assert.strictEqual(registry.has("no-such-id"), false);
    });

    it("returns true after create()", () => {
      registry.create({ sessionId: "h1" });
      assert.strictEqual(registry.has("h1"), true);
    });

    it("returns false after remove()", () => {
      registry.create({ sessionId: "h2" });
      registry.remove("h2");
      assert.strictEqual(registry.has("h2"), false);
    });
  });

  // ---- list ----

  describe("list()", () => {
    it("returns an empty array when the registry is empty", () => {
      assert.deepStrictEqual(registry.list(), []);
    });

    it("returns all records when no predicate is supplied", () => {
      registry.create({ sessionId: "l1" });
      registry.create({ sessionId: "l2" });
      assert.strictEqual(registry.list().length, 2);
    });

    it("filters by predicate", () => {
      registry.create({ sessionId: "l3", kind: "tcp" });
      registry.create({ sessionId: "l4", kind: "udp" });
      const udpOnly = registry.list((r) => r.kind === "udp");
      assert.strictEqual(udpOnly.length, 1);
      assert.strictEqual(udpOnly[0].sessionId, "l4");
    });

    it("returns copies — mutations do not affect stored records", () => {
      registry.create({ sessionId: "l5" });
      registry.list()[0].state = "MUTATED";
      assert.strictEqual(registry.get("l5").state, "connecting");
    });
  });

  // ---- update ----

  describe("update()", () => {
    it("returns null for an unknown id", () => {
      assert.strictEqual(registry.update("no-such-id", {}), null);
    });

    it("merges the patch and returns a copy", () => {
      registry.create({ sessionId: "u1", state: "connecting" });
      const updated = registry.update("u1", { state: "connected" });
      assert.strictEqual(updated.state, "connected");
    });

    it("persists the patch", () => {
      registry.create({ sessionId: "u2", state: "connecting" });
      registry.update("u2", { state: "connected" });
      assert.strictEqual(registry.get("u2").state, "connected");
    });

    it("refreshes updatedAt", () => {
      registry.create({ sessionId: "u3" });
      const before = registry.get("u3").updatedAt;
      const updated = registry.update("u3", { state: "connected" });
      assert.ok(updated.updatedAt >= before);
    });
  });

  // ---- touch ----

  describe("touch()", () => {
    it("updates lastActivityAt", () => {
      registry.create({ sessionId: "t1" });
      const before = registry.get("t1").lastActivityAt;
      registry.touch("t1");
      const after = registry.get("t1").lastActivityAt;
      assert.ok(after >= before);
    });

    it("is a no-op for an unknown id (does not throw)", () => {
      assert.doesNotThrow(() => registry.touch("no-such-id"));
    });
  });

  // ---- remove ----

  describe("remove()", () => {
    it("returns true and deletes the record", () => {
      registry.create({ sessionId: "r1" });
      assert.strictEqual(registry.remove("r1"), true);
      assert.strictEqual(registry.has("r1"), false);
    });

    it("returns false for an unknown id", () => {
      assert.strictEqual(registry.remove("no-such-id"), false);
    });
  });

  // ---- clear ----

  describe("clear()", () => {
    it("removes all records", () => {
      registry.create({});
      registry.create({});
      registry.clear();
      assert.strictEqual(registry.list().length, 0);
    });

    it("is safe to call on an already-empty registry", () => {
      assert.doesNotThrow(() => registry.clear());
    });
  });
});
