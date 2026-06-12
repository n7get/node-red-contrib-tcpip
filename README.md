# node-red-contrib-tcpip

Simple, flow-oriented TCP and UDP connectivity for Node-RED. Open outbound TCP
connections, accept inbound ones, send and receive UDP datagrams — all without
writing any socket code. Each connection is tracked by a `sessionId` that flows
through your wires, so routing data to the right socket is as natural as wiring
nodes together.

---

## Installation

From your Node-RED user directory (usually `~/.node-red`):

```bash
npm install /home/ubuntu/node-red-contrib-tcpip
# or, once published:
npm install node-red-contrib-tcpip
```

Then restart Node-RED. Six nodes appear under the **tcpip** palette category:
`tcp connect`, `tcp listen`, `tcp send`, `tcp disconnect`, `udp in`, `udp out`.

This module has **zero runtime dependencies** — it uses only the Node.js core
`net`, `dgram`, `events` and `crypto` modules. Requires Node.js >= 20.

---

## Package concepts

### Sessions and the `sessionId`

Every live connection — one TCP socket or one bound UDP socket — is a
**session**. When `tcp connect` or `tcp listen` opens a connection it allocates
a unique `sessionId` (e.g. `sess-<uuid>`) and stamps it on every message it
emits. `tcp send` and `tcp disconnect` then operate on that session using
**only** `msg.sessionId`; they need no direct reference to the node that opened
it. This is what lets a single flow manage many connections simultaneously.

You can force a specific id by setting `msg.sessionId` on the input to
`tcp connect`; otherwise one is generated automatically.

### Two outputs: events and data

Most nodes have two outputs: 

**Output 1** carries lifecycle signals —
`connecting`, `connected`, `disconnected`, `sent`, `timeout`, `error`, and so
on. Wire it to a **switch** node to branch on `msg.event`, or to a **debug**
node to monitor activity. Errors always arrive here with `status: "error"`,
`errorCode`, and `errorText`.

**Output 2** carries inbound payload with `event: "data"`. Wire it to whatever
processes the received bytes or text. In binary mode `payload` is a `Buffer`; in
line mode it is a string per line, or an array when **Wait For** is active.

Nodes that only send (`tcp disconnect`, `udp out`) have a single events output.
`udp in` has no input — it binds at deploy time and emits on both outputs.

### Message envelopes

Every message emitted by a node carries:

| field | always | meaning |
|-------|--------|---------|
| `timestamp` | yes | ISO-8601 emit time |
| `status` | yes | `"ok"` or `"error"` |
| `event` | yes | `connecting`, `connected`, `listening`, `data`, `sent`, `disconnecting`, `disconnected`, `closed`, `timeout`, `error` |
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
| `sessionId` | string | force a specific session id |

**Output 1 (events):** `connecting` → `connected` → … → `disconnected`, plus
`timeout` / `error`.
**Output 2 (data):** inbound data. Payload is a `Buffer` (binary mode) or a
`String` (line mode).

In **line mode** the stream is split on `\r\n`, `\n` or `\r`. An optional
**Wait For** RegExp buffers complete lines until one matches, then emits
`{ payload: [linesBefore], match: "<matching line>" }` — handy for prompt-based
protocols.

**Timeout:** configure an inactivity timeout (ms) on the node. The timer resets
on every inbound chunk and on every successful `tcp send` write. When it fires,
a `TIMEOUT` error is emitted on the events output of whichever node currently
holds the data claim for that session.

### `tcp listen`

Accepts inbound TCP/IPv4 connections on a configured port. **Outputs:** `[events, data]`.

**Config:** Host (bind address, default `0.0.0.0`), Port, Mode (`binary` / `line`),
Wait For (RegExp, line mode), Timeout (ms).

Starts listening at deploy time. Each accepted connection gets its own `sessionId`.
The `tcp send` and `tcp disconnect` nodes can operate on any accepted session
using only its `sessionId`.

**Output 1 (events):**

| event | when |
|-------|------|
| `listening` | server bound (`localHost`, `localPort`) |
| `connected` | inbound connection accepted (`sessionId`, `remoteHost`, `remotePort`) |
| `disconnected` | connection closed (`sessionId`) |
| `closed` | server socket closed on redeploy/shutdown |
| `error` / `timeout` | server or per-session error |

**Output 2 (data):** same shape as `tcp connect` — one message per line (line
mode) or per chunk (binary mode), tagged with `sessionId`.

To **reject** an incoming connection, wire the `connected` event into a
`tcp disconnect` node (optionally filtering on `remoteHost` / `remotePort` first).

### `tcp send`

Sends data on an existing session and **claims** that session's data output, so
the response is routed back to this node. **Outputs:** `[events, data]`.

**Input:**

| property | type | notes |
|----------|------|-------|
| `sessionId` | string | required — the session to send on |
| `payload` | string \| Buffer \| array | array items are written separately |
| `waitFor` | string | RegExp pattern; buffers lines until a match |
| `timeout` | number | inactivity timeout (ms); overrides node config |

When the session is in **line mode**, a configurable **Line Terminator** (`lf`,
`crlf`, or `cr`) is appended to each string item before writing.

**Output 1 (events):** `sent` (`sessionId`, `messageId`, `chunkCount`) or an error.
**Output 2 (data):** the server response for this session.

Error codes: `SESSION_NOT_FOUND`, `SESSION_NOT_CONNECTED`, `PAYLOAD_INVALID`,
`SOCKET_NOT_CONNECTED`.

### `tcp disconnect`

Closes a session. **Output:** `[events]`.

**Input:** `msg.sessionId` (required).
**Output:** `disconnecting` ack, or `SESSION_NOT_FOUND`. The owning `tcp connect`
or `tcp listen` node emits the final `disconnected` event when the socket fully
closes.

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

### TCP outbound request / response

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

### TCP server (accept inbound connections)

```
[tcp listen] ─events→ [switch on msg.event]
             └─data──→ [debug]

   (connected event carries sessionId + remoteHost + remotePort)
        ↓ set msg.sessionId + msg.payload
   [tcp send] ─events→ [debug "sent"]
              └─data──→ [debug "client data"]

   later:  [inject sessionId] → [tcp disconnect]
```

1. Deploy `tcp listen` with a port. It emits `{event:"listening"}` then
   `{event:"connected", sessionId, remoteHost, remotePort}` for each client.
2. Use the `sessionId` with `tcp send` to reply, or `tcp disconnect` to close.

### Inactivity timeout

Set **Timeout** (ms) on `tcp connect` or `tcp listen`. The timer resets on every
inbound byte and every outbound send. On expiry a `TIMEOUT` error is emitted:

```json
{ "status": "error", "errorCode": "TIMEOUT", "errorText": "Inactivity timeout",
  "event": "timeout", "sessionId": "sess-..." }
```

A `tcp send` node can override the timeout per message via `msg.timeout`.

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
| `lib/tcp-server.js` | `net.Server` lifecycle wrapper (events: listening/connection/error/close) |
| `lib/udp-socket.js` | `dgram` wrapper (bind / send / multicast / broadcast) |

### Output claim pattern

A session's inbound data must reach exactly one node. The runtime store keeps a
**data claim** (`sessionId → node`) and a **lifecycle claim**. `tcp connect` and
`tcp listen` take both claims when a session is created; each `tcp send`
*re-claims* the data output so its response routes back to it, while lifecycle
events (connected, disconnected, timeout, error) always stay with the originating
`tcp connect` or `tcp listen` node.

---

## License

MIT
