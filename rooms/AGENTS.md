# AGENTS.md — Room IPC Plugin

Guidance for agents modifying this project.

## Project Structure

```
src/plugins/rooms/
├── index.ts            # Plugin entry point — tool registration, lifecycle hooks
├── room-manager.ts     # Core RoomManager class — all room/member/retry/logging logic
├── ring-buffer.ts      # Fixed-size ring buffer for bounded message inboxes
├── openclaw.plugin.json # Plugin manifest (required by OpenClaw)
├── package.json        # Package metadata with openclaw.extensions entry
└── README.md           # User-facing documentation
```

## Critical: Tool Registration Pattern

OpenClaw plugin tools MUST use the **factory function pattern** with a `names` hint:

```ts
api.registerTool(
  (ctx) => {
    if (!ctx.agentId) return null;
    return { name: "my_tool", parameters: {...}, async execute(_id, params) {...} };
  },
  { names: ["my_tool"] },
);
```

The static object pattern (`api.registerTool({ name, parameters, execute })`) shown in some docs **does not work** — tools register silently but never appear in the agent tool catalog. This was verified empirically. See memory-core plugin for a working reference.

The `ctx` object provides: `ctx.agentId`, `ctx.sessionKey`, `ctx.config`.

## Plugin Export Pattern

Use the object export matching memory-core:

```ts
const plugin = {
  id: "rooms",
  name: "Room IPC",
  description: "...",
  configSchema: { type: "object", additionalProperties: false, properties: {} },
  register(api) { ... },
};
export default plugin;
```

## Dependencies

This plugin has **zero external dependencies**. Keep it that way. Linked plugins (`-l` flag) resolve Node modules from their own directory, not OpenClaw's — adding deps means they must be installed locally in the plugin dir.

Use plain JSON Schema objects for tool parameters, not TypeBox.

## Manifest Requirements

`openclaw.plugin.json` must exist with a valid `configSchema` (even if empty). Without it, OpenClaw refuses to load the plugin.

`package.json` must include `openclaw.extensions` pointing to the entry file.

## Logging

All log calls include key info **in the message string itself**, not just in the metadata object. The gateway console formatter only renders the message string — structured metadata goes to JSONL file logs only.

```ts
// Correct — info visible on console AND in structured logs
this.log.info(`Room created: ${roomName} by ${agentId} (${sessionId})`, { room: roomName, createdBy: agentId, sessionId });

// Wrong — console just shows "Room created" with no details
this.log.info("Room created", { room: roomName, createdBy: agentId, sessionId });
```

Transcript files are written to `~/.openclaw/rooms/<roomName>.log` via `logToTranscript()`.

## Testing Changes

1. Edit the source files
2. Restart the gateway: `openclaw gateway restart` (or container restart)
3. Verify plugin loaded: `openclaw plugins list` — look for `rooms | loaded`
4. Test tools by having an agent call `room_join`, `room_send`, etc.
5. Check gateway console for log output
6. Check transcript: `cat ~/.openclaw/rooms/<roomName>.log`

## Architecture Decisions

- **In-memory state**: Rooms are ephemeral. Gateway restart clears all rooms. This is intentional — rooms are for live collaboration, not persistence.
- **Inbox model**: Messages are buffered in per-member ring buffers. Agents poll via `room_recv`. No push delivery to agent sessions.
- **agentId as parameter**: Agents pass their own agentId because the static tool execute signature (`execute(_id, params)`) doesn't provide session context. The factory function's `ctx.agentId` is available at registration time but not at execution time.
- **Rate limiting**: 20 messages per agent per room per second, enforced via a token bucket per member.
- **No external deps**: Runs entirely in-process using Node.js primitives. No Redis, no IPC sockets, no external services.
- **Pull-based delivery, no protocol schemas**: Room messages are delivered via the `room_recv` tool (as tool return values), not as server-push WebSocket events. No TypeBox protocol schemas are needed. If a future version adds server-push delivery, add TypeBox schemas and register them in the gateway protocol schema.

## Common Pitfalls

- Don't use `{ optional: true }` on registerTool unless you specifically want opt-in behavior — optional tools require explicit allowlisting and are never auto-enabled.
- Don't forget the `{ names: [...] }` second argument on registerTool — without it, the factory pattern may not register tools correctly.
- After modifying plugin code, a gateway restart is required. Hot reload does not apply to plugin source.
- The `session_end` hook fires when agent sessions end — this is where room cleanup happens. If cleanup isn't working, check that the hook is registered correctly.
