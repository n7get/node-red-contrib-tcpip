# Node Messages Reference

All messages include a `timestamp` (ISO 8601 string).  
Messages with `status: "ok"` are built by `okEnvelope(fields)`.  
Messages with `status: "error"` are built by `errorEnvelope(errorCode, errorText, fields)` and always include `errorCode` and `errorText`.

---

## tcp-connect

Opens an outbound TCP/IPv4 connection. Two outputs: **output 1** (events), **output 2** (data).

### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `host` | string | no¹ | Remote host. Overrides node config. |
| `port` | number | no¹ | Remote port. Overrides node config. |
| `sessionId` | string | no | Force a specific session id; auto-generated (`sess-<uuid>`) if omitted. |

¹ Required unless provided by node config.

### Output 1 — events

#### `status: "ok"` messages

| `event` | Additional fields | When |
|---|---|---|
| `connecting` | `sessionId`, `remoteHost`, `remotePort` | Connect attempt started (immediate ack) |
| `connected` | `sessionId`, `remoteHost`, `remotePort`, `localPort` | TCP handshake completed |
| `disconnected` | `sessionId` | Socket fully closed |

#### `status: "error"` messages

| `errorCode` | `errorText` | Additional fields | When |
|---|---|---|---|
| `CONNECT_INVALID` | `connect requires host and port` | `event: "error"` | Host or port could not be resolved |
| `SESSION_ID_CONFLICT` | `Session already exists` | `event: "error"`, `sessionId` | Supplied `sessionId` is already in use |
| `CONNECT_FAILED` | Connection error message | `event: "error"`, `sessionId` | TCP socket emitted an error |
| `TRANSPORT_ERROR` | Transport error message | `event: "error"`, `sessionId` | Unexpected socket error |
| `TIMEOUT` | `Inactivity timeout` | `event: "timeout"`, `sessionId` | Inactivity timer fired |

> **Note:** `TIMEOUT` errors may be emitted by a **tcp-send** node instead of the tcp-connect node if a send node currently holds the data claim for the session.

### Output 2 — data

All data messages have `status: "ok"` and `event: "data"`.

| Mode | `payload` type | `match` field | When |
|---|---|---|---|
| `binary` | `Buffer` | — | Inbound bytes received from socket |
| `line` (no waitFor) | `string` | — | One complete line received (`\r\n`, `\n`, or `\r` delimited) |
| `line` (waitFor active) | `string[]` — lines before the match | `string` — the matching line or fragment | First line matching the `waitFor` regex arrives |
| `line` (disconnect flush) | `string[]` — buffered lines | — | Session disconnects while lines are buffered |

### Status badge

| Condition | Badge |
|---|---|
| Idle (no auto-connect) | grey ring — `idle` |
| Connecting | yellow dot — `connecting` |
| Connected | green dot — `connected` |
| Disconnected | grey ring — `disconnected` |
| Timeout | red ring — `timeout` |
| Error | red dot — `error` |

---

## tcp-listen

Accepts inbound TCP/IPv4 connections on a configured port. No input. Two outputs: **output 1** (events), **output 2** (data).

Starts listening at deploy time. Emits a `listening` event when the server is bound. Each accepted connection gets its own `sessionId`. The `tcp-send` and `tcp-disconnect` nodes can operate on any accepted session using only its `sessionId`.

### Output 1 — events

#### `status: "ok"` messages

| `event` | Additional fields | When |
|---|---|---|
| `listening` | `localHost`, `localPort` | Server successfully bound |
| `connected` | `sessionId`, `remoteHost`, `remotePort`, `localHost`, `localPort` | Inbound connection accepted |
| `disconnected` | `sessionId` | Connection closed |
| `closed` | — | Server socket closed (on redeploy/shutdown) |

#### `status: "error"` messages

| `errorCode` | `errorText` | Additional fields | When |
|---|---|---|---|
| `SERVER_ERROR` | Server error message or error code | `event: "error"` | Server-level socket error (e.g. `EADDRINUSE`) |
| `TRANSPORT_ERROR` | Transport error message | `event: "error"`, `sessionId` | Error on an accepted socket |
| `TIMEOUT` | `Inactivity timeout` | `event: "timeout"`, `sessionId` | Inactivity timer fired on an accepted session |

> **Note:** `TIMEOUT` errors may be emitted by a **tcp-send** node instead of the tcp-listen node if a send node currently holds the data claim for the session.

### Output 2 — data

Same shape as tcp-connect output 2. `mode` (`"binary"` or `"line"`) and `timeout` are set in the node editor and apply to all accepted connections.

| Mode | `payload` type | `match` field | When |
|---|---|---|---|
| `binary` | `Buffer` | — | Inbound bytes received |
| `line` | `string` | — | One complete line received |
| `line` (disconnect flush) | `string[]` — buffered lines | — | Session closes while lines are buffered |

---

## tcp-send

Sends data on an existing TCP session and claims that session's data output. Two outputs: **output 1** (events), **output 2** (data).

### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | yes | ID of the target session |
| `payload` | string \| Buffer \| Array<string\|Buffer> | yes | Data to write. Array items are written as separate socket writes. |
| `waitFor` | string | no | Regex pattern (as a string). Claims data output and buffers lines until a match. Overrides node config. |
| `timeout` | number | no | Inactivity timeout in ms. Overrides node config. |

When `mode` is `"line"` and a line terminator is configured on the node (`lf`, `crlf`, or `cr`), the terminator is appended to each string item before writing.

### Output 1 — events

#### `status: "ok"` messages

| `event` | Additional fields | When |
|---|---|---|
| `sent` | `sessionId`, `messageId`, `chunkCount` | All payload items written to socket |

#### `status: "error"` messages

| `errorCode` | `errorText` | Additional fields | When |
|---|---|---|---|
| `SESSION_NOT_FOUND` | `Session not found` | `event: "error"`, `sessionId` | `msg.sessionId` not in the session registry |
| `SESSION_NOT_CONNECTED` | `Session is not connected` | `event: "error"`, `sessionId` | Session exists but state is not `"connected"` |
| `PAYLOAD_INVALID` | `payload items must be string or Buffer` | `event: "error"`, `sessionId` | A payload item is neither a string nor a Buffer |
| `SOCKET_NOT_CONNECTED` | `Socket is not connected` | `event: "error"`, `sessionId` | Transport not found in session index or socket write failed |

### Output 2 — data

Same shape as tcp-connect output 2. The tcp-send node takes the data output claim when it processes an input; data arrives on this output until the session disconnects or a different tcp-send node claims it.

---

## tcp-disconnect

Initiates graceful close of an existing TCP session. One output (events).

### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string | yes | ID of the session to close |

### Output — events

#### `status: "ok"` messages

| `event` | Additional fields | When |
|---|---|---|
| `disconnecting` | `sessionId` | `socket.end()` called (FIN sent) |

#### `status: "error"` messages

| `errorCode` | `errorText` | Additional fields | When |
|---|---|---|---|
| `SESSION_NOT_FOUND` | `Session not found` | `event: "error"`, `sessionId` | `msg.sessionId` not in the session registry |

> The corresponding `disconnected` event is emitted by the **tcp-connect** or **tcp-listen** node that owns the lifecycle claim when the socket fully closes.

---

## udp-in

Binds a UDP/IPv4 socket and emits received datagrams. No input. Two outputs: **output 1** (events), **output 2** (data).

Binds at deploy time. Supports joining a multicast group. `SO_REUSEADDR` is enabled by default (required for multicast and shared-port scenarios).

### Output 1 — events

#### `status: "ok"` messages

| `event` | Additional fields | When |
|---|---|---|
| `listening` | `sessionId`, `address`, `port`, `multicastGroup` | Socket successfully bound |

#### `status: "error"` messages

| `errorCode` | `errorText` | Additional fields | When |
|---|---|---|---|
| `UDP_ERROR` | Error message | `event: "error"`, `sessionId` | Socket error (e.g. `EADDRINUSE`, network error) |

### Output 2 — data

| `status` | `event` | Fields | Description |
|---|---|---|---|
| `ok` | `data` | `sessionId`, `payload` (Buffer or string), `rinfo` | One message per received datagram |

`payload` is a raw `Buffer` when `mode` is `"binary"` (default), or a UTF-8
decoded string when `mode` is `"utf8"`. `rinfo` contains `address`, `port`,
and `size` describing the sender.

---

## udp-out

Sends UDP/IPv4 datagrams (unicast, multicast, or broadcast). One output (events).

A send-only socket is created at deploy time. Host and port come from node
config and can be overridden per message.

### Input

| Field | Type | Required | Description |
|---|---|---|---|
| `payload` | string \| Buffer | yes | Datagram payload |
| `host` | string | no | Destination host. Overrides node config. |
| `port` | number | no | Destination port. Overrides node config. |

### Output — events

#### `status: "ok"` messages

| `event` | Additional fields | When |
|---|---|---|
| `sent` | `sessionId`, `host`, `port`, `bytes` | Datagram handed to OS network stack |

#### `status: "error"` messages

| `errorCode` | `errorText` | Additional fields | When |
|---|---|---|---|
| `SEND_INVALID` | `udp-out requires host and port` | `event: "error"`, `sessionId` | Host or port not resolved |
| `PAYLOAD_INVALID` | `payload must be string or Buffer` | `event: "error"`, `sessionId` | Payload is neither a string nor a Buffer |
| `UDP_SEND_FAILED` | Error message | `event: "error"`, `sessionId` | `socket.send()` returned an error |
| `UDP_ERROR` | Error message | `event: "error"`, `sessionId` | Socket-level error (emitted asynchronously) |
