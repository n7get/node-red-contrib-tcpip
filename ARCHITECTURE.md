# Architecture: node-red-contrib-tcpip

## Layers

```
┌─────────────────────────────────────────────────────────────┐
│  Node-RED flow                                              │
│  (inject, function, debug, etc.)                            │
└──────────────────────┬──────────────────────────────────────┘
                       │ msg
┌──────────────────────▼──────────────────────────────────────┐
│  Node layer  (nodes/)                                       │
│  tcp-connect · tcp-listen · tcp-send · tcp-disconnect       │
│  udp-in · udp-out                                           │
└──────┬───────────────────────────┬──────────────────────────┘
       │ transport calls           │ bus events
┌──────▼──────────┐   ┌────────────▼──────────────────────────┐
│ TcpClient       │   │ runtime-store                         │
│ (lib/tcp-       │   │ (lib/runtime-store.js)                │
│  client.js)     │   │                                       │
│                 │   │  globalBus  — EventEmitter            │
│ TcpServer       │   │  sessionIndex — Map<id, transport>    │
│ (lib/tcp-       │   │  claims — Map<id, {node, waitFor}>    │
│  server.js)     │   │  lifecycleClaims — Map<id, node>      │
│                 │   │  lineBuffers / waitForBuffers         │
│ UdpSocket       │   │  deliverData()                        │
│ (lib/udp-       │   └──────────────┬────────────────────────┘
│  socket.js)     │                  │ session metadata
│                 │   ┌──────────────▼────────────────────────┐
│  Node.js        │   │ SessionRegistry                       │
│  net.Socket     │   │ (lib/session-registry.js)             │
│  net.Server     │   │ CRUD for session records; all getters │
│  dgram.Socket   │   │ return copies; collision detection    │
└──────┬──────────┘   └───────────────────────────────────────┘
       │ raw bytes / datagrams
┌──────▼──────────────────────────────────────────────────────┐
│  Network                                                    │
│  TCP/IPv4 · UDP/IPv4                                        │
└─────────────────────────────────────────────────────────────┘
```

## Shared lib modules

| Module | Role |
|--------|------|
| `message-utils.js` | `nowTimestamp()`, `makeMessageId()`, `okEnvelope()`, `errorEnvelope()` |
| `session-registry.js` | CRUD for session records; keyed by `sessionId`; all getters return copies; `create` throws `SESSION_ID_CONFLICT` on collision |
| `runtime-store.js` | Process-wide singleton: `sessionIndex`, `globalBus`, output `claims`, `lifecycleClaims`, per-session receive buffers, `deliverData()`, `purgeSession()` |
| `tcp-client.js` | `TcpClient` — wraps `net.Socket`; emits `connecting`, `connect`, `data`, `timeout`, `error`, `close`; injectable `socketFactory` for testing |
| `tcp-server.js` | `TcpServer` — wraps `net.Server`; emits `listening`, `connection`, `error`, `close`; injectable `serverFactory` for testing |
| `udp-socket.js` | `UdpSocket` — wraps `dgram`; supports bind (receive), open (send-only), multicast join, broadcast; injectable `dgramFactory` for testing |

## Output claim pattern

Two independent claims exist per session:

**Lifecycle claim** — set once when the session is created (by `tcp-connect` or
`tcp-listen`) and never transferred. The lifecycle-claim owner receives
`connecting`, `connected`, `disconnecting`, `disconnected`, `timeout`, and
`error` events on its events output.

**Data claim** — starts with the node that created the session. When a `tcp-send`
node processes an input message it takes over the data claim for that session.
Any pending `waitFor` buffer is flushed to the previous owner before the transfer.
This means each `tcp-send` in a chain receives the server reply to its own
command.

Both claims are maps keyed by `sessionId` in `runtime-store`.

## runtime-store: global bus and session index

`runtime-store` is a module-level singleton (shared via `require` caching).

**`globalBus`** is an `EventEmitter` (max listeners = 0 = unlimited). Transport
wrappers and nodes emit the following bus events:

| Event | Emitted by | Consumed by |
|-------|-----------|-------------|
| `conn-lifecycle` | `tcp-connect` (bridged from TcpClient), `tcp-listen` (bridged from TcpServer sockets) | `tcp-connect`, `tcp-listen` (lifecycle-claim holders) |
| `conn-data` | `tcp-connect`, `tcp-listen` (bridged from socket `data` events) | `tcp-connect`, `tcp-listen`, `tcp-send` (data-claim holders) |
| `conn-timeout-set` | `tcp-send` (after a successful write when timeout is active) | `tcp-connect` (to re-arm the per-session inactivity timer) |

**`sessionIndex`** maps `sessionId → transport` (TcpClient, net.Socket, or
UdpSocket). `tcp-send` and `tcp-disconnect` look up the transport here at
message-handling time — no static reference to the connect node is needed.

## deliverData

`runtime-store.deliverData(params, emit)` turns a raw inbound `chunk` into one
or more output envelopes depending on the session's mode:

- **binary** — one envelope per call; `payload` is the raw `Buffer`.
- **line** — chunk is appended to the `lineBuffer`; the buffer is split on
  `\r\n` / `\n` / `\r`; one envelope is emitted per complete line with
  `payload` as a string. The trailing fragment is kept in the buffer.
  - Without `waitFor`: each line is emitted immediately.
  - With `waitFor` RegExp: complete lines (and the trailing fragment when it
    matches) are tested against the pattern; when a match is found the buffered
    preceding lines are emitted as `payload` (array) and the matching line as
    `match`. Non-matching lines accumulate in `waitForBuffer`.

## Node internals pattern

All TCP nodes follow this structural pattern:

```
node constructor
  ├── validate config (host, port, regex, etc.)
  ├── subscribe to globalBus (conn-lifecycle, conn-data, conn-timeout-set)
  ├── create transport (TcpClient / TcpServer) — or open UdpSocket
  └── bridge transport events onto globalBus

node.on("input", ...)
  ├── tcp-connect — validate host/port, create registry record, connect TcpClient
  ├── tcp-send    — validate sessionId + payload, transfer claim, write to transport
  └── tcp-disconnect — validate sessionId, call transport.end()

node.on("close", ...)
  └── unsubscribe from globalBus; destroy owned transports; purge sessions
```

## Node status badges

### tcp-connect

| Condition | Status |
|-----------|--------|
| No auto-connect, idle | grey ring — `idle` |
| Connecting | yellow dot — `connecting` |
| Connected | green dot — `connected` |
| Disconnected | grey ring — `disconnected` |
| Timeout | red ring — `timeout` |
| Error | red dot — `error` |
| Bad `waitFor` regex | red ring — `bad waitFor regex` |

### tcp-listen

| Condition | Status |
|-----------|--------|
| Listening | green dot — `listening :<port>` |
| Error | red dot — `<error code>` |
| Closed | grey ring — `closed` |
| Port not configured | red ring — `port required` |

### udp-in

| Condition | Status |
|-----------|--------|
| Bound and listening | green dot — `listening :<port>` |
| Error | red dot — `error` |
| Closed | grey ring — `closed` |
| Port not configured | red ring — `missing port` |

### udp-out

| Condition | Status |
|-----------|--------|
| Ready (socket open) | grey ring — `ready` |
| Message sent | green dot — `sent <N>b` |
| Error | red dot — `error` |

## Session lifecycle states

```
tcp-connect:  connecting → connected → disconnected
                                ↓
                             (error)

tcp-listen:   (server listening) → connected (per accepted socket)
                                        → disconnected
                                        → (timeout / error)

udp-in/out:   connecting → connected
```

States are stored in the session registry record (`record.state`) and updated
by the node as transport events arrive.

## Testability design

- `TcpClient` accepts an injectable `socketFactory` — tests pass a fake factory
  returning a mock `net.Socket`
- `TcpServer` accepts an injectable `serverFactory` — tests pass a fake factory
  returning a mock `net.Server`
- `UdpSocket` accepts an injectable `dgramFactory` — tests pass a fake factory
  returning a mock `dgram.Socket`
- `SessionRegistry` and `runtime-store` are instantiated fresh in each test via
  proxyquire module substitution, preventing state leakage between tests
