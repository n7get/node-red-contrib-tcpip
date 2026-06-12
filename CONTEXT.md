# Project Context: node-red-contrib-tcpip

## What this is

A Node-RED contrib package that enables TCP/IP and UDP connectivity. It lets
Node-RED flows open outbound TCP connections, accept inbound TCP connections,
and send or receive UDP datagrams — without writing any socket code. Multiple
simultaneous connections are tracked by a process-wide `sessionId`, so a
single flow can handle many connections at once.

The package provides six custom nodes covering outbound TCP, inbound TCP (server
accept), send-and-receive, graceful disconnect, UDP receive, and UDP send.

## Target users

Node-RED users who need to communicate over raw TCP sockets or UDP datagrams —
for example, integrating legacy equipment, industrial PLCs, home automation
devices, or any system that speaks a line-based or binary TCP protocol.

## Runtime environment

- Node.js 20 LTS, CommonJS modules
- Node-RED 3.x+
- No external runtime dependencies (only Node.js `net`, `dgram`, `events`, and `crypto`)

## Key design decisions

**No config node.** There is no shared configuration node. Each `tcp-connect` or
`tcp-listen` node owns its transport independently. The process-wide `runtime-store`
module (a singleton via `require` caching) is the global coordinator that lets
`tcp-send` and `tcp-disconnect` locate a live socket from only a `sessionId`.

**`sessionId`-based routing.** Every live connection has a unique `sessionId`
(a `sess-<uuid>` string). `tcp-send` and `tcp-disconnect` operate on sessions
using **only** `msg.sessionId` — they never reference the connect node directly.
`runtime-store` maintains a `sessionIndex` map (`sessionId → transport`) and
`claims` / `lifecycleClaims` maps for output routing.

**Inbound data follows the last active claim.** The data output for a session is
owned by whichever node most recently processed a send for that session. On first
connection the `tcp-connect` or `tcp-listen` node holds the claim; when a
`tcp-send` node handles an input it takes over the data output for that session.
This lets flows chain request/response steps naturally: each `tcp-send` in the
chain receives the reply to its own send.

**Binary and line modes.** The `tcp-connect` and `tcp-listen` nodes have a `mode`
setting (default: `binary`) that controls how inbound data is delivered:

- **binary** — each received chunk emitted immediately; `payload` is a `Buffer`.
- **line** — chunks are buffered and split on `\r\n`, `\n`, or `\r`; each
  complete line is emitted with `payload` as a string. If `waitFor` (a RegExp)
  is set, lines accumulate until one matches; the output message then contains
  `payload` (array of preceding lines) and `match` (the matching line). If a
  session disconnects while lines are buffered, the buffer is flushed.

`mode` and `waitFor` are set on the node; `tcp-send` can also carry a `waitFor`
pattern which takes effect when that node claims the data output.

**Inactivity timeout.** A timeout (in ms) can be set on `tcp-connect`,
`tcp-listen`, or overridden per-message on `tcp-send`. When the timer fires the
owning node (whichever holds the lifecycle claim) emits a `TIMEOUT` error on its
events output. The timer is re-armed on every inbound chunk and on every
successful `tcp-send` write.

**Line terminator injection.** `tcp-send` has a configurable line terminator
(`lf`, `crlf`, or `cr`) that is appended to string payloads when the session is
in line mode. Useful for protocols that require `\r\n`-terminated commands.

**IPv4 only.** All TCP and UDP sockets use IPv4 (`family: 4` for `net.Socket`,
`udp4` for `dgram`).

**UDP: unicast, multicast, and broadcast.** `udp-in` binds a socket and supports
joining a multicast group (`SO_REUSEADDR` is on by default for multicast). `udp-out`
sends datagrams; broadcast is enabled via a checkbox; multicast TTL can be
configured. Both `host` and `port` can be overridden per message.

**Message envelopes.** Every output message carries `timestamp` (ISO-8601) and
`status` (`"ok"` or `"error"`). Error messages additionally carry `errorCode`
(SCREAMING_SNAKE) and `errorText` (human-readable string).

## Message contract summary

All output messages include `timestamp` and `status`. Errors always include
`errorCode` and `errorText`. Session lifecycle events include `sessionId` and
`event` (`connecting`, `connected`, `disconnecting`, `disconnected`, `timeout`,
`error`). Inbound data messages include `sessionId`, `event: "data"`, and
`payload` (Buffer in binary mode, string in line mode). Sent confirmations
include `sessionId`, `messageId`, and `chunkCount`.

Full contract details are in [MESSAGES.md](MESSAGES.md).

## Node list

| Node | Direction | Role |
|------|-----------|------|
| `tcp-connect` | in + 2 out | Open an outbound TCP connection; output 1: lifecycle events; output 2: received data |
| `tcp-listen` | 2 out | Accept inbound TCP connections on a port; output 1: lifecycle events; output 2: received data |
| `tcp-send` | in + 2 out | Send data on an existing session; output 1: events; output 2: received data |
| `tcp-disconnect` | in + 1 out | Initiate graceful close of a session; output 1: events |
| `udp-in` | 2 out | Bind a UDP socket and emit received datagrams; output 1: events; output 2: data |
| `udp-out` | in + 1 out | Send a UDP datagram; output 1: events |

## Test strategy

Two test layers under `test/`:

- **lib/** — isolated module behavior (message envelopes, session registry,
  runtime store, data delivery, line/binary/waitFor modes)
- **nodes/** — node loading and wiring with proxyquire-injected mocks (fake
  TCP client, fake UDP socket); covers session lifecycle, routing, error codes,
  claim transfer, mode toggles, auto-connect, and inactivity timers

No live TCP or UDP sockets are required for any test.

## Project layout

```text
nodes/          runtime JS + editor HTML for all six node types
lib/            shared internals (transports, registry, store, message utils)
test/           lib unit tests + node behavior tests
local/          importable Node-RED example flows
```

## Known limitations and deferred work

- IPv6 is not supported
- No TLS support for TCP transport
- `tcp-connect` does not auto-reconnect on transport drop; the flow must send
  a new message to reconnect
