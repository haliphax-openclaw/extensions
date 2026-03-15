import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";

vi.mock("fs", () => ({
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
}));

import { RoomManager, type RoomManagerDeps } from "./room-manager";

function makeDeps(): { log: RoomManagerDeps } {
  return { log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } };
}

describe("RoomManager", () => {
  let mgr: RoomManager;
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = makeDeps();
    mgr = new RoomManager(deps);
  });

  // --- Room creation and destruction ---

  describe("room lifecycle", () => {
    it("creates a room on first join", () => {
      const result = mgr.join("agent1", "s1", "test-room");
      expect(result.room).toBe("test-room");
      expect(result.members).toEqual(["agent1"]);
    });

    it("destroys room when last member leaves", () => {
      mgr.join("agent1", "s1", "test-room");
      mgr.leave("agent1", "test-room");
      expect(mgr.list("agent1").rooms).toEqual([]);
    });

    it("does not destroy room while members remain", () => {
      mgr.join("agent1", "s1", "room1");
      mgr.join("agent2", "s2", "room1");
      mgr.leave("agent1", "room1");
      const listed = mgr.list("agent2");
      expect(listed.rooms).toHaveLength(1);
      expect(listed.rooms[0].members).toEqual(["agent2"]);
    });

    it("destroy() clears all state", () => {
      mgr.join("agent1", "s1", "room1");
      mgr.join("agent2", "s2", "room2");
      mgr.destroy();
      expect(mgr.list("agent1").rooms).toEqual([]);
      expect(mgr.list("agent2").rooms).toEqual([]);
    });
  });

  // --- Join / Leave ---

  describe("join and leave", () => {
    it("idempotent rejoin returns current members without duplicate", () => {
      mgr.join("agent1", "s1", "room1");
      mgr.join("agent2", "s2", "room1");
      const result = mgr.join("agent1", "s1", "room1");
      expect(result.members).toEqual(["agent1", "agent2"]);
    });

    it("leave is a no-op for non-member", () => {
      mgr.join("agent1", "s1", "room1");
      // Should not throw
      mgr.leave("agent2", "room1");
      mgr.leave("agent1", "nonexistent");
    });
  });

  // --- Broadcast ---

  describe("broadcast", () => {
    it("delivers message to all members except sender", () => {
      mgr.join("agent1", "s1", "room1");
      mgr.join("agent2", "s2", "room1");
      mgr.join("agent3", "s3", "room1");
      // Drain presence events from joins
      mgr.recv("agent1");
      mgr.recv("agent2");
      mgr.recv("agent3");

      const result = mgr.send("agent1", "room1", "hello");
      expect(result.delivered).toBe(2);

      const msgs2 = mgr.recv("agent2");
      expect(msgs2).toHaveLength(1);
      expect(msgs2[0].from).toBe("agent1");
      expect(msgs2[0].payload?.body).toBe("hello");

      const msgs3 = mgr.recv("agent3");
      expect(msgs3).toHaveLength(1);

      // Sender gets nothing
      expect(mgr.recv("agent1")).toHaveLength(0);
    });

    it("throws when sending to a room agent is not in", () => {
      mgr.join("agent1", "s1", "room1");
      expect(() => mgr.send("agent2", "room1", "hi")).toThrow("Not a member");
    });

    it("throws when sending to nonexistent room", () => {
      expect(() => mgr.send("agent1", "nope", "hi")).toThrow("Not a member");
    });
  });

  // --- recv ---

  describe("recv", () => {
    it("consumes messages on read", () => {
      mgr.join("agent1", "s1", "room1");
      mgr.join("agent2", "s2", "room1");
      mgr.send("agent1", "room1", "msg1");
      mgr.send("agent1", "room1", "msg2");

      const first = mgr.recv("agent2");
      expect(first).toHaveLength(2);

      const second = mgr.recv("agent2");
      expect(second).toHaveLength(0);
    });

    it("recv with room filter only returns messages from that room", () => {
      mgr.join("agent1", "s1", "room1");
      mgr.join("agent1", "s1", "room2");
      mgr.join("agent2", "s2", "room1");
      mgr.join("agent2", "s2", "room2");

      mgr.send("agent1", "room1", "in-room1");
      mgr.send("agent1", "room2", "in-room2");

      const msgs = mgr.recv("agent2", "room1");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].payload?.body).toBe("in-room1");

      // room2 message still pending
      const msgs2 = mgr.recv("agent2", "room2");
      expect(msgs2).toHaveLength(1);
      expect(msgs2[0].payload?.body).toBe("in-room2");
    });

    it("recv with no rooms returns empty", () => {
      expect(mgr.recv("nobody")).toEqual([]);
    });
  });

  // --- list ---

  describe("list", () => {
    it("lists all rooms for an agent", () => {
      mgr.join("agent1", "s1", "room1");
      mgr.join("agent1", "s1", "room2");
      const result = mgr.list("agent1");
      expect(result.rooms).toHaveLength(2);
      const names = result.rooms.map((r) => r.name).sort();
      expect(names).toEqual(["room1", "room2"]);
    });

    it("lists specific room with members", () => {
      mgr.join("agent1", "s1", "room1");
      mgr.join("agent2", "s2", "room1");
      const result = mgr.list("agent1", "room1");
      expect(result.rooms).toHaveLength(1);
      expect(result.rooms[0].members).toEqual(["agent1", "agent2"]);
    });

    it("returns empty for nonexistent room", () => {
      expect(mgr.list("agent1", "nope").rooms).toEqual([]);
    });

    it("returns empty for agent with no rooms", () => {
      expect(mgr.list("nobody").rooms).toEqual([]);
    });
  });

  // --- Rate limiting ---

  describe("rate limiting", () => {
    it("allows up to 20 messages per second", () => {
      mgr.join("agent1", "s1", "room1");
      mgr.join("agent2", "s2", "room1");
      for (let i = 0; i < 20; i++) {
        mgr.send("agent1", "room1", `msg${i}`);
      }
      expect(() => mgr.send("agent1", "room1", "too-many")).toThrow("rate_limited");
    });

    it("resets after the time window", () => {
      mgr.join("agent1", "s1", "room1");
      mgr.join("agent2", "s2", "room1");
      for (let i = 0; i < 20; i++) {
        mgr.send("agent1", "room1", `msg${i}`);
      }

      // Advance time past the rate bucket reset
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1100);
      expect(() => mgr.send("agent1", "room1", "after-reset")).not.toThrow();
      vi.restoreAllMocks();
    });
  });

  // --- Limits enforcement ---

  describe("limits", () => {
    it("max 10 rooms per agent", () => {
      for (let i = 0; i < 10; i++) {
        mgr.join("agent1", "s1", `room${i}`);
      }
      expect(() => mgr.join("agent1", "s1", "room10")).toThrow("already in 10 rooms");
    });

    it("max 50 members per room", () => {
      for (let i = 0; i < 50; i++) {
        mgr.join(`agent${i}`, `s${i}`, "big-room");
      }
      expect(() => mgr.join("agent50", "s50", "big-room")).toThrow("full");
    });
  });

  // --- Room name validation ---

  describe("room name validation", () => {
    it("accepts valid names", () => {
      expect(() => mgr.join("a", "s", "my-room")).not.toThrow();
      expect(() => mgr.join("a", "s", "Room:123")).not.toThrow();
      expect(() => mgr.join("a", "s", "a")).not.toThrow();
    });

    it("rejects empty name", () => {
      expect(() => mgr.join("a", "s", "")).toThrow("Invalid room name");
    });

    it("rejects names starting with hyphen", () => {
      expect(() => mgr.join("a", "s", "-bad")).toThrow("Invalid room name");
    });

    it("rejects names with spaces", () => {
      expect(() => mgr.join("a", "s", "bad name")).toThrow("Invalid room name");
    });

    it("rejects names longer than 64 chars", () => {
      expect(() => mgr.join("a", "s", "a".repeat(65))).toThrow("Invalid room name");
    });

    it("accepts name of exactly 64 chars", () => {
      expect(() => mgr.join("a", "s", "a".repeat(64))).not.toThrow();
    });
  });

  // --- Session disconnect cleanup ---

  describe("removeBySession", () => {
    it("removes agent from all rooms on session disconnect", () => {
      mgr.join("agent1", "s1", "room1");
      mgr.join("agent1", "s1", "room2");
      mgr.join("agent2", "s2", "room1");

      mgr.removeBySession("s1");

      expect(mgr.list("agent1").rooms).toEqual([]);
      // agent2 still in room1
      const result = mgr.list("agent2", "room1");
      expect(result.rooms).toHaveLength(1);
      expect(result.rooms[0].members).toEqual(["agent2"]);
    });

    it("no-op for unknown session", () => {
      mgr.removeBySession("unknown");
      // Should not throw
    });
  });

  // --- Presence events ---

  describe("presence events", () => {
    it("delivers join presence to existing members", () => {
      mgr.join("agent1", "s1", "room1");
      mgr.join("agent2", "s2", "room1");

      const msgs = mgr.recv("agent1");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("room:presence");
      expect(msgs[0].event).toBe("join");
      expect(msgs[0].agentId).toBe("agent2");
      expect(msgs[0].members).toContain("agent1");
      expect(msgs[0].members).toContain("agent2");
    });

    it("delivers leave presence to remaining members", () => {
      mgr.join("agent1", "s1", "room1");
      mgr.join("agent2", "s2", "room1");
      // Drain join presence
      mgr.recv("agent1");

      mgr.leave("agent2", "room1");

      const msgs = mgr.recv("agent1");
      expect(msgs).toHaveLength(1);
      expect(msgs[0].type).toBe("room:presence");
      expect(msgs[0].event).toBe("leave");
      expect(msgs[0].agentId).toBe("agent2");
    });

    it("no presence event for the joining agent itself", () => {
      mgr.join("agent1", "s1", "room1");
      // agent1 is the first member, no one to notify
      expect(mgr.recv("agent1")).toHaveLength(0);
    });
  });

  // --- Transcript logging ---

  describe("transcript logging", () => {
    it("creates log directory on construction", () => {
      expect(fs.mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
    });

    it("writes to transcript on join", () => {
      mgr.join("agent1", "s1", "room1");
      expect(fs.appendFileSync).toHaveBeenCalledWith(
        expect.stringContaining("room1.log"),
        expect.stringContaining("JOIN agent1")
      );
    });

    it("writes to transcript on room creation", () => {
      mgr.join("agent1", "s1", "room1");
      expect(fs.appendFileSync).toHaveBeenCalledWith(
        expect.stringContaining("room1.log"),
        expect.stringContaining("ROOM CREATED")
      );
    });

    it("writes to transcript on send", () => {
      mgr.join("agent1", "s1", "room1");
      mgr.join("agent2", "s2", "room1");
      mgr.send("agent1", "room1", "hello world");
      expect(fs.appendFileSync).toHaveBeenCalledWith(
        expect.stringContaining("room1.log"),
        expect.stringContaining("MSG [agent1] hello world")
      );
    });

    it("writes to transcript on leave", () => {
      mgr.join("agent1", "s1", "room1");
      mgr.leave("agent1", "room1");
      expect(fs.appendFileSync).toHaveBeenCalledWith(
        expect.stringContaining("room1.log"),
        expect.stringContaining("LEAVE agent1")
      );
    });

    it("writes ROOM DESTROYED on last member leave", () => {
      mgr.join("agent1", "s1", "room1");
      mgr.leave("agent1", "room1");
      expect(fs.appendFileSync).toHaveBeenCalledWith(
        expect.stringContaining("room1.log"),
        expect.stringContaining("ROOM DESTROYED")
      );
    });

    it("logs error if transcript write fails", () => {
      vi.mocked(fs.appendFileSync).mockImplementation(() => {
        throw new Error("disk full");
      });
      mgr.join("agent1", "s1", "room1");
      expect(deps.log.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to write room transcript"),
        expect.objectContaining({ error: "disk full" })
      );
    });
  });
});
