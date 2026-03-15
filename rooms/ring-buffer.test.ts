import { describe, it, expect } from "vitest";
import { RingBuffer } from "./ring-buffer";

describe("RingBuffer", () => {
  it("push and pop single item", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    expect(buf.length).toBe(1);
    expect(buf.pop()).toBe(1);
    expect(buf.length).toBe(0);
  });

  it("push and pop multiple items in FIFO order", () => {
    const buf = new RingBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(buf.pop()).toBe(1);
    expect(buf.pop()).toBe(2);
    expect(buf.pop()).toBe(3);
  });

  it("peek returns head without removing", () => {
    const buf = new RingBuffer<string>(3);
    buf.push("a");
    buf.push("b");
    expect(buf.peek()).toBe("a");
    expect(buf.length).toBe(2);
  });

  it("pop on empty buffer returns undefined", () => {
    const buf = new RingBuffer<number>(3);
    expect(buf.pop()).toBeUndefined();
    expect(buf.length).toBe(0);
  });

  it("peek on empty buffer returns undefined", () => {
    const buf = new RingBuffer<number>(3);
    expect(buf.peek()).toBeUndefined();
  });

  it("evicts oldest item when full", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    const evicted = buf.push(4);
    expect(evicted).toBe(1);
    expect(buf.length).toBe(3);
    expect(buf.pop()).toBe(2);
    expect(buf.pop()).toBe(3);
    expect(buf.pop()).toBe(4);
  });

  it("returns undefined when push does not evict", () => {
    const buf = new RingBuffer<number>(3);
    expect(buf.push(1)).toBeUndefined();
    expect(buf.push(2)).toBeUndefined();
  });

  it("multiple overflows evict in order", () => {
    const buf = new RingBuffer<number>(2);
    buf.push(1);
    buf.push(2);
    expect(buf.push(3)).toBe(1);
    expect(buf.push(4)).toBe(2);
    expect(buf.pop()).toBe(3);
    expect(buf.pop()).toBe(4);
  });

  it("clear resets the buffer", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.clear();
    expect(buf.length).toBe(0);
    expect(buf.pop()).toBeUndefined();
  });

  it("works after clear and reuse", () => {
    const buf = new RingBuffer<number>(2);
    buf.push(1);
    buf.push(2);
    buf.clear();
    buf.push(10);
    expect(buf.length).toBe(1);
    expect(buf.pop()).toBe(10);
  });

  it("capacity of 1", () => {
    const buf = new RingBuffer<string>(1);
    buf.push("a");
    expect(buf.push("b")).toBe("a");
    expect(buf.length).toBe(1);
    expect(buf.pop()).toBe("b");
  });
});
