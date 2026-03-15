# OpenClaw Room-Based Multi-Agent IPC — Design Document

## 1. IPC Primitive Selection

**Choice: In-process EventEmitter (Node.js native)**

All agent sessions live inside a single Gateway process. The "isolation" between agents is logical (separate session state), not OS-level process isolation. A plain `EventEmitter` (or thin wrapper) gives:

- Zero-copy message passing (objects stay in the V8 heap)
- Sub-microsecond dispatch latency
- Native backpressure via the Node.js event loop
- No file descriptors, no cleanup on crash, no permission issues
- Trivial integration with the existing typed message protocol

If OpenClaw later moves to multi-process (worker threads or child processes), the abstraction can be swapped to `BroadcastChannel` or Unix domain sockets without changing the agent-facing API.

**Rejected alternatives:**

| Primitive | Why not |
|---|---|
| Unix domain sockets | Cross-process primitive; agents share a process. Adds FD management, serialization, and cleanup for no gain. |
| Named pipes (FIFOs) | Unidirectional, awkward for broadcast, filesystem cleanup required. |
| Shared memory + eventfd | Maximum complexity. Useful for high-throughput binary data between processes, overkill here. |
| `BroadcastChannel` | Only works across `worker_threads`. Agents aren't in separate threads today. Good future migration path. |
| Redis/NATS/etc. | Explicitly excluded by requirements. |

---

## 2. Room Lifecycle

### Data structures

```
RoomManager
  ├── rooms: Map<roomName, Room>

Room
  ├── name: string
  ├── members: Map<agentId, RoomMember>
  ├── createdAt: number
  ├── emitter: EventEmitter

RoomMember
  ├── agentId: string
  ├── sessionKey: string
  ├── joinedAt: number
  ├── deliver: (msg) => boolean       // returns false if ws buffer is full
  ├── retryBuffer: RingBuffer<RetryEntry>  // fixed-size, e.g. 20 entries
  ├── retryTimer: NodeJS.Timeout | null
```

```typescript
interface RetryEntry {
  msg: RoomDeliverMessage;
  attempts: number;
  queuedAt: number;
}
```

### Operations

**Create** — implicit on first join. No explicit create step. Rooms are cheap (an EventEmitter + a Map entry). Avoids "who creates the room" coordination.

**Join** — agent calls `room_join(roomName)`. The RoomManager:
1. Creates the room if it doesn't exist.
2. Adds the agent to `room.members`.
3. Registers the agent's delivery callback on `room.emitter`.
4. Broadcasts a `room:presence` event (`{type: "join", agentId}`) to existing members.
5. Returns the current member list to the joining agent.

**Leave** — agent calls `room_leave(roomName)`, or is removed automatically on session disconnect. The RoomManager:
1. Removes the agent from `room.members`.
2. Unregisters the delivery callback.
3. Clears the member's `retryTimer` and drops the retry buffer.
4. Broadcasts `room:presence` event (`{type: "leave", agentId}`) to remaining members.

**Destroy** — implicit when last member leaves. The RoomManager deletes the room from the map. The EventEmitter is GC'd.

---

## 3. Message Format and Delivery Semantics

### Wire format (extends existing typed message protocol)

```typescript
// Agent → Gateway (outbound)
interface RoomSendMessage {
  type: "room:send";
  room: string;
  payload: {
    contentType: "text" | "json";
    body: string;
  };
  nonce?: string;
}

// Gateway → Agent (inbound)
interface RoomDeliverMessage {
  type: "room:deliver";
  room: string;
  from: string;             // agentId of sender
  payload: {
    contentType: "text" | "json";
    body: string;
  };
  ts: number;               // server timestamp (Date.now())
  nonce?: string;
}

// Gateway → Agent (presence)
interface RoomPresenceMessage {
  type: "room:presence";
  room: string;
  event: "join" | "leave";
  agentId: string;
  members: string[];        // current member list after the event
  ts: number;
}
```

### Delivery semantics

- **At-most-once with best-effort retry.** Messages are dispatched synchronously via the EventEmitter. If delivery fails, the message is queued for bounded retry (see below). After retries are exhausted, the message is dropped.
- **No self-delivery.** The sender is excluded from broadcast.
- **Causal ordering per sender.** Messages from a single agent arrive in send order (guaranteed by the single-threaded event loop). Retried messages arrive late by definition — no reordering guarantees across retried vs. non-retried messages.
- **No history.** Agents that join late don't receive past messages.

### Bounded retry with expiry

When delivery fails (`ws.bufferedAmount` over high-water mark or `ws.send()` throws):

1. Push the message into the member's retry ring buffer (fixed size: 20 messages).
2. Schedule a retry pass via `setTimeout` with backoff: 50ms → 200ms → 500ms.
3. On each retry pass, check `ws.bufferedAmount`. If clear, flush the buffer in order. If still blocked, increment attempts and reschedule.
4. Max 3 retry attempts per message. After that, drop.
5. Messages older than 5 seconds are evicted regardless of retry count.

The ring buffer is fixed-size — when full, oldest messages are evicted. This caps memory usage regardless of how badly a consumer is stalled. One `setTimeout` per stalled member, not per message.

```typescript
function flushRetries(member: RoomMember) {
  const now = Date.now();
  while (member.retryBuffer.length > 0) {
    const entry = member.retryBuffer.peek();
    if (now - entry.queuedAt > 5000 || entry.attempts >= 3) {
      member.retryBuffer.pop();
      continue;
    }
    if (member.deliver(entry.msg)) {
      member.retryBuffer.pop();
    } else {
      entry.attempts++;
      const delay = entry.attempts === 1 ? 50 : entry.attempts === 2 ? 200 : 500;
      member.retryTimer = setTimeout(() => flushRetries(member), delay);
      return;
    }
  }
  member.retryTimer = null;
}
```

### Backpressure

- Check `ws.bufferedAmount < HIGH_WATER_MARK` (64KB) before delivery.
- If over: queue to retry buffer instead of dropping immediately.
- If retry buffer is also full: oldest entry is evicted, new message takes its slot.

---

## 4. Integration Points with Existing Gateway

### Where RoomManager lives

```
Gateway
  ├── WebSocketServer        (existing)
  ├── SessionManager         (existing — manages agent:<agentId>:... keys)
  ├── RoomManager            (new — singleton)
```

### Message routing

The existing WebSocket message handler dispatches on `message.type`. Add cases for `room:send`, `room:join`, `room:leave`, `room:list`. These call into `RoomManager` methods which synchronously fan out via EventEmitter to member delivery callbacks.

Each delivery callback writes to the target agent's WebSocket using the existing `session.send()` path — no new transport.

### Session disconnect hook

The existing session teardown logic must call `RoomManager.removeAgent(agentId)` to clean up all room memberships, clear retry timers, and drop retry buffers. Single addition to the existing disconnect handler.

### Relationship to `sessions_send`

`sessions_send` remains for point-to-point async communication. Rooms are a separate, complementary channel. No changes to `sessions_send` needed.

---

## 5. API Surface for Agents

### `room_join`

```
Parameters:
  room: string    // alphanumeric + hyphens, max 64 chars

Returns:
  { room: string, members: string[] }
```

Idempotent — joining a room you're already in returns current state.

### `room_leave`

```
Parameters:
  room: string

Returns:
  { ok: true }
```

No-op if not a member.

### `room_send`

```
Parameters:
  room: string
  message: string
  contentType?: "text" | "json"    // default: "text"

Returns:
  { delivered: number, buffered: number }
```

Broadcasts to all other members. `buffered` = queued for retry (rough signal of room health). Fails if agent is not a member.

### `room_list`

```
Parameters:
  room?: string    // if provided, list members of that room
                   // if omitted, list all rooms the agent belongs to

Returns:
  { rooms: [{ name: string, members: string[], createdAt: number }] }
```

### Inbound delivery

Room messages arrive as unsolicited inbound messages on the agent's existing session WebSocket using `room:deliver` and `room:presence` types. The agent framework surfaces these as system messages in the agent's context window, similar to `sessions_send` inbound handling.

---

## 6. Edge Cases and Failure Modes

| Scenario | Handling |
|---|---|
| Agent disconnects after joining | Session disconnect hook calls `removeAgent` — leaves all rooms, clears retry timers/buffers, broadcasts presence. |
| Agent sends to room it hasn't joined | Error: `"not a member of room: X"`. |
| Room name collision | Names are global. Convention: prefix with project/task ID (e.g. `task-42:planning`). No enforced namespacing in v1. |
| Message storm | Rate limit per agent per room: 20 msgs/sec. Excess returns `rate_limited` error. |
| Slow consumer | Queued to retry buffer. After 3 attempts or 5s expiry, dropped. Ring buffer evicts oldest if full. |
| Agent joins many rooms | Cap at 10 rooms per agent. |
| Gateway restart | All rooms are in-memory — they vanish. Agents must re-join on reconnect. Acceptable for ephemeral collaboration. |
| EventEmitter listener leak | Per-agent room cap (10) + disconnect cleanup prevents unbounded growth. Set `emitter.setMaxListeners()` to `members.size + margin`. |
| Duplicate join (race) | `members` is a Map keyed by agentId. Second join overwrites — idempotent. |
| Retry timer outlives membership | `room_leave` and `removeAgent` both clear `retryTimer` and drop the buffer. |

---

## 7. Security Considerations

### Room access control

**v1: Open rooms.** Any agent can join any room by name. Matches the current trust model where all agents run within a single Gateway under one operator.

**v2 (if needed):** Add optional `allowList` on room creation, or `room:invite` flow where only existing members can add new ones. `room_join` checks `room.allowList.includes(agentId)` before admitting.

### Message content isolation

- Room messages delivered only to members. Non-members cannot read room traffic.
- Gateway never persists room messages to disk. Messages exist only in flight or in bounded retry buffers.

### Agent identity

- `from` field is set by the Gateway from the authenticated session, not self-reported. Agents cannot spoof the sender.

### Resource exhaustion

- Per-agent room cap: 10 rooms.
- Per-agent per-room rate limit: 20 msg/sec.
- Per-room member cap: 50 agents.
- Per-member retry buffer: 20 messages, 5s TTL.
- Backpressure on slow consumers.

### Sensitive data

- Agents should treat room messages like any inter-agent communication — no secrets, no PII, no credentials.
- Room message body content is never logged by default. Payload size is logged at `debug` level.

---

## 8. Observability

Room IPC integrates with OpenClaw's existing logging, diagnostics, and metrics infrastructure. No custom logging is needed.

### Subsystem logger

`RoomManager` creates a sub-logger with prefix `[rooms]`. This provides JSONL file logs with `{ subsystem: "rooms" }` for filtering, TTY-prefixed console output, and independent level control via existing config.

Log levels:
- `info` — room created, room destroyed, agent joined, agent left
- `debug` — message broadcast (room, from, payload size, delivered count, buffered count)
- `warn` — retry buffer full (evicting oldest), rate limit hit, backpressure triggered
- `error` — `ws.send()` threw during delivery

### Diagnostic events

Extend the existing event catalog:

| Event | Emitted when | Key fields |
|---|---|---|
| `room.join` | Agent joins a room | `room`, `agentId`, `memberCount` |
| `room.leave` | Agent leaves a room | `room`, `agentId`, `memberCount`, `reason` (`explicit` / `disconnect`) |
| `room.broadcast` | Message dispatched | `room`, `from`, `delivered`, `buffered`, `payloadBytes` |
| `room.delivery.failed` | Message dropped after retry exhaustion | `room`, `targetAgentId`, `attempts`, `reason` (`expired` / `max_retries` / `evicted`) |

These flow through the existing in-process diagnostics emitter and are automatically exported via OTLP if enabled.

### OpenTelemetry metrics

Added to the existing metric set:

- `openclaw.room.members` (gauge, labels: `room`) — current member count
- `openclaw.room.broadcast` (counter, labels: `room`) — messages broadcast
- `openclaw.room.delivery.retry` (counter, labels: `room`) — messages queued for retry
- `openclaw.room.delivery.dropped` (counter, labels: `room`, `reason`) — messages dropped

### Redaction

Room message bodies follow the existing `logging.redactSensitive` setting. Body content logging (if ever needed for debugging) is gated behind `diagnostics.flags: ["rooms.payload"]`, matching the existing pattern for sensitive subsystem debug output.

---

## 9. Facilitator-Driven Orchestration (Announce Protocol)

A thin protocol convention on top of existing primitives (`sessions_send` + `room_send`) that lets a facilitator agent create a collaboration session, invite specific agents, and wait for readiness before starting.

No new Gateway primitives are required — this is purely a message payload convention.

### Flow

```
Facilitator                          Agent A              Agent B
    │                                   │                    │
    ├── room_join("task-42:collab") ───►│                    │
    │                                   │                    │
    ├── sessions_send(agentA, {         │                    │
    │     type: "room:invite",          │                    │
    │     room: "task-42:collab",       │                    │
    │     role: "researcher"            │                    │
    │   }) ────────────────────────────►│                    │
    │                                   │                    │
    ├── sessions_send(agentB, {         │                    │
    │     type: "room:invite",          │                    │
    │     room: "task-42:collab",       │                    │
    │     role: "reviewer"              │                    │
    │   }) ────────────────────────────────────────────────►│
    │                                   │                    │
    │              room_join("task-42:collab") ◄─────────────┤
    │              room_join("task-42:collab") ◄──┤          │
    │                                   │                    │
    │◄── room_send({                    │                    │
    │      type: "announce",            │                    │
    │      agentId: "agentA",           │                    │
    │      role: "researcher",          │                    │
    │      capabilities: ["web_search", │                    │
    │        "file_read"],              │                    │
    │      status: "ready"              │                    │
    │    }) ◄───────────────────────────┤                    │
    │                                   │                    │
    │◄── room_send({                    │                    │
    │      type: "announce",            │                    │
    │      agentId: "agentB",           │                    │
    │      role: "reviewer",            │                    │
    │      capabilities: ["code_review",│                    │
    │        "file_write"],             │                    │
    │      status: "ready"              │                    │
    │    }) ◄────────────────────────────────────────────────┤
    │                                   │                    │
    ├── room_send({                     │                    │
    │      type: "session:start",       │                    │
    │      agenda: "Review PR #123",    │                    │
    │      participants: [...]          │                    │
    │   }) ────────────────────────────►├───────────────────►│
    │                                   │                    │
    ▼           collaboration begins    ▼                    ▼
```

### Message conventions

These are `room_send` payloads with `contentType: "json"`. No new wire types.

```typescript
// Facilitator → Agent (via sessions_send, point-to-point)
interface RoomInvite {
  type: "room:invite";
  room: string;
  role?: string;          // suggested role for the agent
  context?: string;       // brief on what the collaboration is about
}

// Agent → Room (via room_send, after joining)
interface AnnounceMessage {
  type: "announce";
  agentId: string;
  role: string;
  capabilities: string[]; // tools/skills this agent can contribute
  status: "ready" | "declined";
}

// Facilitator → Room (via room_send, after all announces received)
interface SessionStartMessage {
  type: "session:start";
  agenda: string;
  participants: { agentId: string; role: string }[];
}
```

### Facilitator readiness logic

1. Create room via `room_join`.
2. Send invites via `sessions_send` (point-to-point, existing mechanism).
3. Listen for `room:deliver` messages where `payload.type === "announce"`.
4. Mark each agent as ready when their announce arrives.
5. When all invited agents have announced (or timeout expires), broadcast `session:start`.

### Timeout and failure handling

- **Announce timeout**: facilitator waits up to a configurable duration (e.g. 30s) for all announces.
- **Partial readiness**: if some agents don't announce in time, the facilitator decides — proceed without them, retry the invite, or abort. This is facilitator logic, not a Gateway concern.
- **Agent declines**: an agent responds with `status: "declined"`. The facilitator handles accordingly.
- **Facilitator crashes**: agents see the facilitator leave via `room:presence`. They can self-elect a new facilitator or leave the room.
