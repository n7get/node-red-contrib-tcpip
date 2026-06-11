"use strict";

const assert = require("assert");
const store = require("../../lib/runtime-store");

// ---- helpers ----

/** Purge every session currently tracked, resetting the singleton cleanly. */
function clearStore() {
  for (const id of [...store.registry.byId.keys()]) {
    store.purgeSession(id);
  }
  // sessionIndex may contain entries that were indexed without a registry record
  // (e.g. during error-path tests). Clear it explicitly.
  store.sessionIndex.clear();
}

afterEach(clearStore);

// ============================================================

describe("runtime-store — transport index", () => {
  it("indexSession / transportForSession round-trip", () => {
    const fake = { type: "fake" };
    store.indexSession("ti1", fake);
    assert.strictEqual(store.transportForSession("ti1"), fake);
  });

  it("unindexSession removes the transport", () => {
    store.indexSession("ti2", { type: "fake" });
    store.unindexSession("ti2");
    assert.strictEqual(store.transportForSession("ti2"), null);
  });

  it("transportForSession returns null for an unknown session", () => {
    assert.strictEqual(store.transportForSession("no-such"), null);
  });
});

// ============================================================

describe("runtime-store — claims", () => {
  it("setClaim / getClaim stores a node + waitFor pair", () => {
    const node = { id: "n1" };
    const rx = /READY/;
    store.setClaim("c1", node, rx);
    const claim = store.getClaim("c1");
    assert.strictEqual(claim.node, node);
    assert.strictEqual(claim.waitFor, rx);
  });

  it("getClaim returns null for an unknown session", () => {
    assert.strictEqual(store.getClaim("no-such"), null);
  });

  it("clearClaim removes the claim", () => {
    store.setClaim("c2", { id: "n2" }, null);
    store.clearClaim("c2");
    assert.strictEqual(store.getClaim("c2"), null);
  });

  it("setClaim with null waitFor stores null", () => {
    store.setClaim("c3", { id: "n3" }, null);
    assert.strictEqual(store.getClaim("c3").waitFor, null);
  });
});

// ============================================================

describe("runtime-store — lifecycle claims", () => {
  it("setLifecycleClaim / getLifecycleClaim round-trip", () => {
    const node = { id: "lc1" };
    store.setLifecycleClaim("lc1", node);
    assert.strictEqual(store.getLifecycleClaim("lc1"), node);
  });

  it("getLifecycleClaim returns null for an unknown session", () => {
    assert.strictEqual(store.getLifecycleClaim("no-such"), null);
  });

  it("clearLifecycleClaim removes the claim", () => {
    store.setLifecycleClaim("lc2", { id: "n" });
    store.clearLifecycleClaim("lc2");
    assert.strictEqual(store.getLifecycleClaim("lc2"), null);
  });
});

// ============================================================

describe("runtime-store — receive buffers", () => {
  afterEach(() => {
    store.clearBuffers("buf1");
    store.clearBuffers("buf2");
    store.clearBuffers("buf3");
  });

  it("getLineBuffer returns empty string for unknown session", () => {
    assert.strictEqual(store.getLineBuffer("buf-unknown"), "");
  });

  it("setLineBuffer / getLineBuffer round-trip", () => {
    store.setLineBuffer("buf1", "partial-line");
    assert.strictEqual(store.getLineBuffer("buf1"), "partial-line");
  });

  it("getWaitForBuffer returns empty array for unknown session", () => {
    assert.deepStrictEqual(store.getWaitForBuffer("buf-unknown"), []);
  });

  it("setWaitForBuffer / getWaitForBuffer round-trip", () => {
    store.setWaitForBuffer("buf2", ["a", "b", "c"]);
    assert.deepStrictEqual(store.getWaitForBuffer("buf2"), ["a", "b", "c"]);
  });

  it("clearBuffers removes both line and waitFor buffers", () => {
    store.setLineBuffer("buf3", "data");
    store.setWaitForBuffer("buf3", ["x"]);
    store.clearBuffers("buf3");
    assert.strictEqual(store.getLineBuffer("buf3"), "");
    assert.deepStrictEqual(store.getWaitForBuffer("buf3"), []);
  });
});

// ============================================================

describe("runtime-store — purgeSession()", () => {
  it("removes registry record, transport, claims and buffers atomically", () => {
    store.registry.create({ sessionId: "p1" });
    store.indexSession("p1", { fake: true });
    store.setClaim("p1", { id: "n" }, null);
    store.setLifecycleClaim("p1", { id: "lc" });
    store.setLineBuffer("p1", "data");
    store.setWaitForBuffer("p1", ["x"]);

    store.purgeSession("p1");

    assert.strictEqual(store.registry.has("p1"), false);
    assert.strictEqual(store.transportForSession("p1"), null);
    assert.strictEqual(store.getClaim("p1"), null);
    assert.strictEqual(store.getLifecycleClaim("p1"), null);
    assert.strictEqual(store.getLineBuffer("p1"), "");
    assert.deepStrictEqual(store.getWaitForBuffer("p1"), []);
  });

  it("is idempotent — calling it twice does not throw", () => {
    store.registry.create({ sessionId: "p2" });
    store.purgeSession("p2");
    assert.doesNotThrow(() => store.purgeSession("p2"));
  });
});

// ============================================================

describe("runtime-store — deliverData() binary mode", () => {
  it("emits a single ok envelope with a Buffer payload", () => {
    const emitted = [];
    store.deliverData(
      { sessionId: "d-bin", mode: "binary", chunk: Buffer.from("hello") },
      (env) => emitted.push(env)
    );
    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(emitted[0].status, "ok");
    assert.ok(Buffer.isBuffer(emitted[0].payload));
    assert.strictEqual(emitted[0].payload.toString(), "hello");
  });

  it("carries sessionId in the envelope", () => {
    const emitted = [];
    store.deliverData(
      { sessionId: "d-bin2", mode: "binary", chunk: Buffer.from("x") },
      (env) => emitted.push(env)
    );
    assert.strictEqual(emitted[0].sessionId, "d-bin2");
  });

  it("merges extra fields into the envelope", () => {
    const emitted = [];
    store.deliverData(
      {
        sessionId: "d-bin3",
        mode: "binary",
        chunk: Buffer.from("x"),
        extra: { rinfo: { address: "1.2.3.4", port: 5000 } },
      },
      (env) => emitted.push(env)
    );
    assert.deepStrictEqual(emitted[0].rinfo, { address: "1.2.3.4", port: 5000 });
  });
});

// ============================================================

describe("runtime-store — deliverData() line mode", () => {
  const SID = "d-line";

  afterEach(() => store.clearBuffers(SID));

  it("emits one envelope per complete line", () => {
    const emitted = [];
    store.deliverData(
      { sessionId: SID, mode: "line", chunk: Buffer.from("foo\nbar\n") },
      (env) => emitted.push(env)
    );
    assert.strictEqual(emitted.length, 2);
    assert.strictEqual(emitted[0].payload, "foo");
    assert.strictEqual(emitted[1].payload, "bar");
  });

  it("buffers an incomplete trailing fragment and flushes on the next chunk", () => {
    const emitted = [];
    store.deliverData(
      { sessionId: SID, mode: "line", chunk: Buffer.from("hel") },
      (env) => emitted.push(env)
    );
    assert.strictEqual(emitted.length, 0);

    store.deliverData(
      { sessionId: SID, mode: "line", chunk: Buffer.from("lo\n") },
      (env) => emitted.push(env)
    );
    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(emitted[0].payload, "hello");
  });

  it("splits on \\r\\n", () => {
    const emitted = [];
    store.deliverData(
      { sessionId: SID, mode: "line", chunk: Buffer.from("a\r\nb\r\n") },
      (env) => emitted.push(env)
    );
    assert.strictEqual(emitted.length, 2);
    assert.strictEqual(emitted[0].payload, "a");
    assert.strictEqual(emitted[1].payload, "b");
  });

  it("splits on bare \\r", () => {
    const emitted = [];
    store.deliverData(
      { sessionId: SID, mode: "line", chunk: Buffer.from("x\ry\r") },
      (env) => emitted.push(env)
    );
    assert.strictEqual(emitted.length, 2);
    assert.strictEqual(emitted[0].payload, "x");
  });

  it("emits nothing for a chunk with no complete lines", () => {
    const emitted = [];
    store.deliverData(
      { sessionId: SID, mode: "line", chunk: Buffer.from("no-newline") },
      (env) => emitted.push(env)
    );
    assert.strictEqual(emitted.length, 0);
  });
});

// ============================================================

describe("runtime-store — deliverData() line mode with waitFor", () => {
  const SID = "d-wf";

  beforeEach(() => {
    store.setClaim(SID, { id: "test-node" }, /READY/);
  });

  afterEach(() => {
    store.clearBuffers(SID);
    store.clearClaim(SID);
  });

  it("buffers lines until a matching line arrives, then flushes", () => {
    const emitted = [];
    store.deliverData(
      {
        sessionId: SID,
        mode: "line",
        chunk: Buffer.from("line1\nline2\nREADY\n"),
      },
      (env) => emitted.push(env)
    );
    assert.strictEqual(emitted.length, 1);
    assert.deepStrictEqual(emitted[0].payload, ["line1", "line2"]);
    assert.strictEqual(emitted[0].match, "READY");
  });

  it("handles a prompt without a trailing newline (trailing fragment match)", () => {
    const emitted = [];
    store.deliverData(
      { sessionId: SID, mode: "line", chunk: Buffer.from("hello\nREADY") },
      (env) => emitted.push(env)
    );
    assert.strictEqual(emitted.length, 1);
    assert.strictEqual(emitted[0].match, "READY");
  });

  it("keeps buffering across multiple chunks when no match yet", () => {
    const emitted = [];
    store.deliverData(
      { sessionId: SID, mode: "line", chunk: Buffer.from("line1\n") },
      (env) => emitted.push(env)
    );
    assert.strictEqual(emitted.length, 0);

    store.deliverData(
      { sessionId: SID, mode: "line", chunk: Buffer.from("line2\n") },
      (env) => emitted.push(env)
    );
    assert.strictEqual(emitted.length, 0);

    store.deliverData(
      { sessionId: SID, mode: "line", chunk: Buffer.from("READY\n") },
      (env) => emitted.push(env)
    );
    assert.strictEqual(emitted.length, 1);
    assert.deepStrictEqual(emitted[0].payload, ["line1", "line2"]);
  });

  it("flushes multiple match groups within a single chunk", () => {
    const emitted = [];
    store.deliverData(
      {
        sessionId: SID,
        mode: "line",
        chunk: Buffer.from("a\nREADY\nb\nREADY\n"),
      },
      (env) => emitted.push(env)
    );
    assert.strictEqual(emitted.length, 2);
    assert.deepStrictEqual(emitted[0].payload, ["a"]);
    assert.deepStrictEqual(emitted[1].payload, ["b"]);
  });
});
