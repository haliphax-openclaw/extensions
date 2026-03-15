# Room IPC Plugin for OpenClaw

Multi-agent broadcast messaging for OpenClaw. Agents join named rooms and exchange messages in real time, enabling collaborative workflows without relying on external services.

All state is in-memory — rooms are ephemeral and reset on gateway restart. Conversations are logged to per-room transcript files that persist across restarts.

## Install

### Standard install (copy)

```bash
openclaw plugins install /path/to/src/plugins/rooms
```

This copies the plugin into `~/.openclaw/extensions/rooms/` and enables it in config.

### Development install (link)

```bash
openclaw plugins install -l /path/to/src/plugins/rooms
```

This adds the plugin path to `plugins.load.paths` without copying. Changes to the source files take effect on gateway restart.

### Post-install

Restart the gateway to load the plugin:

```bash
openclaw gateway restart
```

Verify it loaded:

```bash
openclaw plugins list
```

You should see `Room IPC | rooms | loaded` in the output.

## Tools

The plugin registers five agent tools. All are available to every agent by default.

### room_join

Join a named room. Creates the room if it doesn't exist. Idempotent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| room | string | yes | Room name (alphanumeric, hyphens, colons, 1-64 chars) |
| agentId | string | yes | Your agent ID |

Returns the current member list.

### room_leave

Leave a room. No-op if not a member.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| room | string | yes | Room name |
| agentId | string | yes | Your agent ID |

### room_send

Broadcast a message to all other agents in a room.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| room | string | yes | Room name |
| message | string | yes | Message content |
| agentId | string | yes | Your agent ID |
| contentType | string | no | `text` (default) or `json` |

Returns the number of agents the message was delivered to.

### room_list

List rooms you belong to, or list members of a specific room.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| agentId | string | yes | Your agent ID |
| room | string | no | Room name (omit to list all your rooms) |

### room_recv

Receive pending messages from your inbox. Returns all messages queued since the last call.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| agentId | string | yes | Your agent ID |
| room | string | no | Room name (omit to receive from all rooms) |

## Logging

### Gateway console

All room events are logged at `info` level with inline details:

```
[rooms] Room created: test-room by main (agent:main:main)
[rooms] Agent joined room: test-room — developer (agent:developer:discord:channel:123) [2 members]
[rooms] Room message [test-room] main (agent:main:main): Hello everyone
[rooms] Agent left room: test-room — developer (agent:developer:discord:channel:123) [1 remaining]
[rooms] Room destroyed: test-room — last agent: main (agent:main:main)
```

### Transcript files

Per-room conversation logs are written to `~/.openclaw/rooms/<roomName>.log`:

```
[2026-03-14T23:58:02.979Z] ROOM CREATED by openclaw-expert (agent:openclaw-expert:discord:channel:123)
[2026-03-14T23:58:22.032Z] JOIN main (agent:main:main) — members: [openclaw-expert, main]
[2026-03-14T23:58:26.236Z] MSG [main] Hello everyone
[2026-03-14T23:59:30.006Z] LEAVE main (agent:main:main) — remaining: 1
```

## Limits

| Limit | Value |
|-------|-------|
| Rooms per agent | 10 |
| Members per room | 50 |
| Messages per agent per room per second | 20 |
| Inbox size per member | 50 messages |

## Architecture

- In-process `EventEmitter`-style design — zero external dependencies
- Messages are buffered in per-member ring buffers (inbox model)
- Agents poll for messages via `room_recv`
- Presence events (join/leave) are delivered to all room members
- Cleanup hooks remove agents from all rooms on session end or gateway stop
