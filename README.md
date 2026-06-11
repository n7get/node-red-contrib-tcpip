# node-red-contrib-tcpip

Node-RED nodes for managing **multiple simultaneous TCP/IP and UDP connections**,
with `sessionId`-based routing, live status badges, and structured error
envelopes. The architecture follows the conventions of
[`node-red-contrib-ax25`](https://github.com/n7get/node-red-contrib-ax25):
a clean split between framework-agnostic logic in `lib/` and thin Node-RED
wrappers in `nodes/`.

> **Status:** `0.1.0`. TCP is IPv4-only. *Listen / accept* (inbound server)
> functionality is intentionally deferred to a later release. Data is exchanged
> as **Buffer** or **String** — no automatic encoding/decoding is performed.

---

## Installation

From your Node-RED user directory (usually `~/.node-red`):

```bash
npm install /home/ubuntu/node-red-contrib-tcpip
# or, once published:
npm install node-red-contrib-tcpip
```

Then restart Node-RED. Five nodes appear under the **tcpip** palette category:
`tcp connect`, `tcp send`, `tcp disconnect`, `udp in`, `udp out`.

This module has **zero runtime dependencies** — it uses only the Node.js core
`net`, `dgram`, `events` and `crypto` modules. Requires Node.js >= 20.

---

## The `sessionId` concept

A **session** is a single live connection (one TCP socket, or one bound/sending
UDP socket). Every session has a unique `sessionId`:

- `tcp connect` allocates a `sessionId` and emits it on its events output.
- `tcp send` and `tcp disconnect` operate on a session using **only** that
  `sessionId` (passed in as `msg.sessionId`) — they do not reference the connect
  node directly. A process-wide *runtime store* maps `sessionId → live socket`.
- `udp in` / `udp out` also allocate a `sessionId` for their socket and stamp it
  on every message.

This lets you run **many connections at once** and route each message to the
correct socket simply by carrying its `sessionId` through your flow.

You may force a specific id by setting `msg.sessionId` on the input to
`tcp connect`; otherwise an id like `sess-<uuid>` is generated.

### Message envelopes

Every message emitted by a node carries:

| field | always | meaning |
|-------|--------|---------|
| `timestamp` | yes | ISO-8601 emit time |
| `status` | yes | `"ok"` or `"error"` |
| `event` | yes | `connecting`, `connected`, `data`, `sent`, `disconnecting`, `disconnected`, `listening`, `timeout`, `error` |
| `sessionId` | usually | the session involved |
| `errorCode` | on error | machine-readable `SCREAMING_SNAKE` code |
| `errorText` | on error | human-readable description |

---

## TCP nodes

### `tcp connect`

Opens an outbound TCP/IPv4 connection. **Outputs:** `[events, data]`.

**Config:** Host, Port, Mode (`binary` / `line`), Wait For (RegExp, line mode),
Timeout (ms), Auto-connect on deploy.

**Input** (when not auto-connecting, send any message to trigger a connect):

| property | type | notes |
|----------|------|-------|
| `host` | string | overrides configured host |
| `port` | number | overrides configured port |
| `sessionId` | string | force a specific id |

**Output 1 (events):** `connecting` → `connected` → … → `disconnected`, plus
`timeout` / `error`.
**Output 2 (data):** inbound data. Payload is a `Buffer` (binary mode) or a
`String` (line mode).

In **line mode** the stream is split on `\r\n`, `\n` or `\r`. An optional
**Wait For** RegExp buffers complete lines until one matches, then emits
`{ payload: [linesBefore], match: "<matching line>" }` — handy for prompt-based
protocols.

### `tcp send`

Sends data on an existing session and **claims** that session's data output, so
the response is routed back to this node. **Outputs:** `[events, data]`.

**Input:**

| property | type | notes |
|----------|------|-------|
| `sessionId` | string | required — the session to send on |
| `payload` | string \| Buffer \| array | array items are written separately |

**Output 1 (events):** `sent` (`messageId`, `chunkCount`) or an error.
**Output 2 (data):** the server response for this session.

Error codes: `SESSION_NOT_FOUND`, `SESSION_NOT_CONNECTED`, `PAYLOAD_INVALID`,
`SOCKET_NOT_CONNECTED`.

### `tcp disconnect`

Closes a session. **Output:** `[events]`.

**Input:** `msg.sessionId` (required).
**Output:** `disconnecting` ack, or `SESSION_NOT_FOUND`. The owning `tcp connect`
node emits the final `disconnected` event when the socket fully closes.

---

## UDP nodes

### `udp in`

Binds a UDP/IPv4 socket and emits received datagrams. **Outputs:** `[events, data]`.
Supports joining a **multicast** group and shared binding via `SO_REUSEADDR`;
**broadcast** datagrams are received by binding the relevant port.

**Config:** Port, Address, Multicast group, Output (`Buffer`/`String`), Reuse address.

**Output 2 (data):** one message per datagram, `payload` = Buffer/String, plus
`rinfo` (`address`, `port`, `size`) describing the sender.

### `udp out`

Sends UDP/IPv4 datagrams (unicast, multicast or broadcast). **Output:** `[events]`.

**Config:** Host, Port, Enable broadcast, Multicast TTL.

**Input:** `payload` (string/Buffer), optional `host` / `port` overrides.
**Output:** `sent` (with `bytes`) or an error (`SEND_INVALID`, `PAYLOAD_INVALID`,
`UDP_SEND_FAILED`).

- **Multicast:** set a Multicast TTL and send to a group address (e.g. `239.1.1.1`).
- **Broadcast:** enable broadcast and send to e.g. `255.255.255.255`.

---

## Usage examples

### TCP request / response

```
[inject host/port] → [tcp connect] ─events→ [switch on msg.event]
                                   └─data──→ [debug]

   (connected event carries sessionId)
        ↓ set msg.sessionId + msg.payload
   [tcp send] ─events→ [debug "sent"]
              └─data──→ [debug "response"]

   later:  [inject sessionId] → [tcp disconnect]
```

1. Trigger `tcp connect`. It replies `{event:"connecting", sessionId}` then
   `{event:"connected", sessionId}`.
2. Carry the `sessionId` into `tcp send` with a `payload`. The server's reply
   arrives on the send node's data output.
3. Send the same `sessionId` to `tcp disconnect` to close.

### Line-based protocol with Wait For

Set Mode = `line` and Wait For = `^OK$` on `tcp connect`. Lines accumulate until
a line equal to `OK` arrives; the node then emits everything before it as an
array plus the matching line in `match`.

### UDP multicast receive + send

- `udp in`: Port `5000`, Multicast group `239.1.1.1`, Reuse address on.
- `udp out`: Host `239.1.1.1`, Port `5000`, Multicast TTL `1`.

---

## Architecture

```
Node-RED flow
  → nodes/*.js   thin RED wrappers (validate, wire events, set status)
    → lib/*.js   RED-agnostic logic (transports, registry, envelopes)
      → net.Socket / dgram.Socket
```

| file | responsibility |
|------|----------------|
| `lib/message-utils.js` | `nowTimestamp`, `makeMessageId`, `okEnvelope`, `errorEnvelope` |
| `lib/session-registry.js` | CRUD for session records; returns copies; collision detection |
| `lib/runtime-store.js` | global `sessionIndex`, `globalBus`, output claims, receive buffers, `deliverData` |
| `lib/tcp-client.js` | `net.Socket` lifecycle wrapper (events: connecting/connect/data/timeout/error/close) |
| `lib/udp-socket.js` | `dgram` wrapper (bind / send / multicast / broadcast) |

### Output claim pattern

A session's inbound data must reach exactly one node. The runtime store keeps a
**data claim** (`sessionId → node`) and a **lifecycle claim**. `tcp connect`
takes both at connect time; each `tcp send` *re-claims* the data output so its
response routes back to it, while lifecycle events always stay with the
originating `tcp connect` node.

---

## License

MIT
