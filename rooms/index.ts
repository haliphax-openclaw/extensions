import { RoomManager } from "./room-manager";

let manager: RoomManager | null = null;

function getManager(log: any): RoomManager {
  if (!manager) {
    manager = new RoomManager({ log });
  }
  return manager;
}

const roomsPlugin = {
  id: "rooms",
  name: "Room IPC",
  description: "Multi-agent room-based broadcast messaging",
  configSchema: { type: "object" as const, additionalProperties: false, properties: {} },

  register(api: any) {
    const log = api.logger;
    const mgr = getManager(log);

    api.on("session_end", async (event: any) => {
      if (event?.sessionId) mgr.removeBySession(event.sessionId);
    });

    api.on("gateway_stop", async () => {
      mgr.destroy();
      manager = null;
    });

    api.registerTool(
      (ctx: any) => {
        if (!ctx.agentId) return null;
        return {
          name: "room_join",
          description:
            "Join a named room for multi-agent broadcast messaging. Returns the current member list. Idempotent.",
          parameters: {
            type: "object",
            properties: {
              room: { type: "string", description: "Room name (alphanumeric, hyphens, colons, 1-64 chars)" },
              agentId: { type: "string", description: "Your agent ID (e.g. main, developer, openclaw-expert)" },
            },
            required: ["room", "agentId"],
          },
          async execute(_id: string, params: { room: string; agentId: string }) {
            try {
              const result = mgr.join(params.agentId, ctx.sessionKey ?? params.agentId, params.room);
              return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
            } catch (err: any) {
              return { content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }) }] };
            }
          },
        };
      },
      { names: ["room_join"] },
    );

    api.registerTool(
      (ctx: any) => {
        if (!ctx.agentId) return null;
        return {
          name: "room_leave",
          description: "Leave a room. No-op if not a member.",
          parameters: {
            type: "object",
            properties: {
              room: { type: "string", description: "Room name to leave" },
              agentId: { type: "string", description: "Your agent ID" },
            },
            required: ["room", "agentId"],
          },
          async execute(_id: string, params: { room: string; agentId: string }) {
            try {
              mgr.leave(params.agentId, params.room);
              return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true }) }] };
            } catch (err: any) {
              return { content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }) }] };
            }
          },
        };
      },
      { names: ["room_leave"] },
    );

    api.registerTool(
      (ctx: any) => {
        if (!ctx.agentId) return null;
        return {
          name: "room_send",
          description:
            "Broadcast a message to all other agents in a room. Returns count of delivered messages.",
          parameters: {
            type: "object",
            properties: {
              room: { type: "string", description: "Room name" },
              message: { type: "string", description: "Message content" },
              agentId: { type: "string", description: "Your agent ID" },
              contentType: { type: "string", enum: ["text", "json"], description: "Default: text" },
            },
            required: ["room", "message", "agentId"],
          },
          async execute(
            _id: string,
            params: { room: string; message: string; agentId: string; contentType?: "text" | "json" }
          ) {
            try {
              const result = mgr.send(params.agentId, params.room, params.message, params.contentType ?? "text");
              return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
            } catch (err: any) {
              return { content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }) }] };
            }
          },
        };
      },
      { names: ["room_send"] },
    );

    api.registerTool(
      (ctx: any) => {
        if (!ctx.agentId) return null;
        return {
          name: "room_list",
          description: "List rooms you belong to, or list members of a specific room.",
          parameters: {
            type: "object",
            properties: {
              room: { type: "string", description: "Room name (omit to list all your rooms)" },
              agentId: { type: "string", description: "Your agent ID" },
            },
            required: ["agentId"],
          },
          async execute(_id: string, params: { room?: string; agentId: string }) {
            try {
              const result = mgr.list(params.agentId, params.room);
              return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
            } catch (err: any) {
              return { content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }) }] };
            }
          },
        };
      },
      { names: ["room_list"] },
    );

    api.registerTool(
      (ctx: any) => {
        if (!ctx.agentId) return null;
        return {
          name: "room_recv",
          description:
            "Receive pending room messages. Returns all messages queued for this agent since the last call.",
          parameters: {
            type: "object",
            properties: {
              room: { type: "string", description: "Room name (omit to receive from all rooms)" },
              agentId: { type: "string", description: "Your agent ID" },
            },
            required: ["agentId"],
          },
          async execute(_id: string, params: { room?: string; agentId: string }) {
            try {
              const messages = mgr.recv(params.agentId, params.room);
              return { content: [{ type: "text" as const, text: JSON.stringify({ messages, count: messages.length }) }] };
            } catch (err: any) {
              return { content: [{ type: "text" as const, text: JSON.stringify({ error: err.message }) }] };
            }
          },
        };
      },
      { names: ["room_recv"] },
    );

    log.info("Rooms plugin registered");
  },
};

export default roomsPlugin;
