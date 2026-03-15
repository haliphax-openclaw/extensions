import { RingBuffer } from "./ring-buffer";
import * as fs from "fs";
import * as path from "path";

const INBOX_SIZE = 50;
const MAX_ROOMS_PER_AGENT = 10;
const MAX_MEMBERS_PER_ROOM = 50;
const RATE_LIMIT_PER_SEC = 20;
const ROOM_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9:\-]{0,63}$/;
const ROOMS_LOG_DIR = path.join(process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME || "/tmp", ".openclaw"), "rooms");

export interface RoomMessage {
  type: "room:deliver" | "room:presence";
  room: string;
  from?: string;
  payload?: { contentType: "text" | "json"; body: string };
  event?: "join" | "leave";
  agentId?: string;
  members?: string[];
  ts: number;
}

interface RoomMember {
  agentId: string;
  sessionId: string;
  inbox: RingBuffer<RoomMessage>;
  rateBucket: { count: number; resetAt: number };
}

interface Room {
  name: string;
  members: Map<string, RoomMember>; // agentId → member
  createdAt: number;
}

export interface RoomManagerDeps {
  info(msg: string, meta?: Record<string, unknown>): void;
  debug?(msg: string, meta?: Record<string, unknown>): void;
  warn?(msg: string, meta?: Record<string, unknown>): void;
  error?(msg: string, meta?: Record<string, unknown>): void;
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private agentRooms = new Map<string, Set<string>>();
  private sessionToAgent = new Map<string, string>();
  private log: RoomManagerDeps;

  constructor(deps: { log: RoomManagerDeps }) {
    this.log = deps.log;
    fs.mkdirSync(ROOMS_LOG_DIR, { recursive: true });
  }

  private logToTranscript(roomName: string, entry: string): void {
    const ts = new Date().toISOString();
    const logFile = path.join(ROOMS_LOG_DIR, `${roomName}.log`);
    try {
      fs.appendFileSync(logFile, `[${ts}] ${entry}\n`);
    } catch (err: any) {
      this.log.error?.("Failed to write room transcript", { room: roomName, error: err.message });
    }
  }

  join(agentId: string, sessionId: string, roomName: string): { room: string; members: string[] } {
    this.validateRoomName(roomName);
    this.sessionToAgent.set(sessionId, agentId);

    const agentSet = this.agentRooms.get(agentId) ?? new Set();
    if (!agentSet.has(roomName) && agentSet.size >= MAX_ROOMS_PER_AGENT) {
      throw new Error(`Agent already in ${MAX_ROOMS_PER_AGENT} rooms`);
    }

    let room = this.rooms.get(roomName);
    if (!room) {
      room = { name: roomName, members: new Map(), createdAt: Date.now() };
      this.rooms.set(roomName, room);
      this.log.info(`Room created: ${roomName} by ${agentId} (${sessionId})`, { room: roomName, createdBy: agentId, sessionId });
      this.logToTranscript(roomName, `ROOM CREATED by ${agentId} (${sessionId})`);
    }

    if (room.members.has(agentId)) {
      return { room: roomName, members: [...room.members.keys()] };
    }

    if (room.members.size >= MAX_MEMBERS_PER_ROOM) {
      throw new Error(`Room ${roomName} is full (${MAX_MEMBERS_PER_ROOM} members)`);
    }

    room.members.set(agentId, {
      agentId,
      sessionId,
      inbox: new RingBuffer(INBOX_SIZE),
      rateBucket: { count: 0, resetAt: Date.now() + 1000 },
    });

    agentSet.add(roomName);
    this.agentRooms.set(agentId, agentSet);

    const memberList = [...room.members.keys()];

    // Deliver presence to existing members
    const presence: RoomMessage = {
      type: "room:presence",
      room: roomName,
      event: "join",
      agentId,
      members: memberList,
      ts: Date.now(),
    };
    this.deliverToOthers(room, agentId, presence);

    this.log.info(`Agent joined room: ${roomName} — ${agentId} (${sessionId}) [${memberList.length} members]`, { room: roomName, agentId, sessionId, memberCount: memberList.length });
    this.logToTranscript(roomName, `JOIN ${agentId} (${sessionId}) — members: [${memberList.join(", ")}]`);
    return { room: roomName, members: memberList };
  }

  leave(agentId: string, roomName: string): void {
    this.leaveInternal(agentId, roomName);
  }

  removeBySession(sessionId: string): void {
    const agentId = this.sessionToAgent.get(sessionId);
    if (!agentId) return;
    this.log.info(`Removing agent by session disconnect: ${agentId} (${sessionId})`, { agentId, sessionId });
    this.removeAgent(agentId);
    this.sessionToAgent.delete(sessionId);
  }

  removeAgent(agentId: string): void {
    const agentSet = this.agentRooms.get(agentId);
    if (!agentSet) return;
    for (const roomName of [...agentSet]) {
      this.leaveInternal(agentId, roomName);
    }
  }

  send(
    agentId: string,
    roomName: string,
    body: string,
    contentType: "text" | "json" = "text"
  ): { delivered: number } {
    const room = this.rooms.get(roomName);
    if (!room || !room.members.has(agentId)) {
      throw new Error(`Not a member of room: ${roomName}`);
    }

    const member = room.members.get(agentId)!;
    if (!this.checkRate(member)) {
      this.log.warn?.(`Rate limited: ${agentId} in ${roomName} (${member.sessionId})`, { room: roomName, agentId, sessionId: member.sessionId });
      throw new Error("rate_limited");
    }

    const msg: RoomMessage = {
      type: "room:deliver",
      room: roomName,
      from: agentId,
      payload: { contentType, body },
      ts: Date.now(),
    };

    const delivered = this.deliverToOthers(room, agentId, msg);

    this.log.info(`Room message [${roomName}] ${agentId} (${member.sessionId}): ${body}`, {
      room: roomName,
      from: agentId,
      sessionId: member.sessionId,
      delivered,
      message: body,
    });
    this.logToTranscript(roomName, `MSG [${agentId}] ${body}`);

    return { delivered };
  }

  recv(agentId: string, roomName?: string): RoomMessage[] {
    const messages: RoomMessage[] = [];
    const rooms = roomName ? [roomName] : [...(this.agentRooms.get(agentId) ?? [])];

    for (const name of rooms) {
      const room = this.rooms.get(name);
      if (!room) continue;
      const member = room.members.get(agentId);
      if (!member) continue;
      while (member.inbox.length > 0) {
        messages.push(member.inbox.pop()!);
      }
    }

    return messages;
  }

  list(agentId: string, roomName?: string): { rooms: { name: string; members: string[]; createdAt: number }[] } {
    if (roomName) {
      const room = this.rooms.get(roomName);
      if (!room) return { rooms: [] };
      return { rooms: [{ name: room.name, members: [...room.members.keys()], createdAt: room.createdAt }] };
    }
    const agentSet = this.agentRooms.get(agentId);
    if (!agentSet) return { rooms: [] };
    return {
      rooms: [...agentSet].map((name) => {
        const room = this.rooms.get(name)!;
        return { name, members: [...room.members.keys()], createdAt: room.createdAt };
      }),
    };
  }

  destroy(): void {
    this.rooms.clear();
    this.agentRooms.clear();
    this.sessionToAgent.clear();
  }

  // --- internals ---

  private leaveInternal(agentId: string, roomName: string): void {
    const room = this.rooms.get(roomName);
    if (!room || !room.members.has(agentId)) return;

    const sessionId = room.members.get(agentId)!.sessionId;
    room.members.delete(agentId);

    const agentSet = this.agentRooms.get(agentId);
    agentSet?.delete(roomName);
    if (agentSet?.size === 0) this.agentRooms.delete(agentId);

    if (room.members.size === 0) {
      this.rooms.delete(roomName);
      this.log.info(`Room destroyed: ${roomName} — last agent: ${agentId} (${sessionId})`, { room: roomName, lastAgent: agentId, sessionId });
      this.logToTranscript(roomName, `ROOM DESTROYED — last agent: ${agentId} (${sessionId})`);
    } else {
      const presence: RoomMessage = {
        type: "room:presence",
        room: roomName,
        event: "leave",
        agentId,
        members: [...room.members.keys()],
        ts: Date.now(),
      };
      this.deliverToOthers(room, agentId, presence);
    }

    this.log.info(`Agent left room: ${roomName} — ${agentId} (${sessionId}) [${room.members.size} remaining]`, { room: roomName, agentId, sessionId, remainingMembers: room.members.size });
    this.logToTranscript(roomName, `LEAVE ${agentId} (${sessionId}) — remaining: ${room.members.size}`);
  }

  private deliverToOthers(room: Room, excludeAgentId: string, msg: RoomMessage): number {
    let count = 0;
    for (const [id, member] of room.members) {
      if (id !== excludeAgentId) {
        member.inbox.push(msg);
        count++;
      }
    }
    return count;
  }

  private checkRate(member: RoomMember): boolean {
    const now = Date.now();
    if (now >= member.rateBucket.resetAt) {
      member.rateBucket.count = 0;
      member.rateBucket.resetAt = now + 1000;
    }
    if (member.rateBucket.count >= RATE_LIMIT_PER_SEC) return false;
    member.rateBucket.count++;
    return true;
  }

  private validateRoomName(name: string): void {
    if (!ROOM_NAME_RE.test(name)) {
      throw new Error(`Invalid room name: "${name}". Alphanumeric/hyphens/colons, 1-64 chars.`);
    }
  }
}
