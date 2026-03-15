export class RingBuffer<T> {
  private buf: (T | undefined)[];
  private head = 0;
  private tail = 0;
  private _length = 0;

  constructor(private capacity: number) {
    this.buf = new Array(capacity);
  }

  get length() {
    return this._length;
  }

  push(item: T): T | undefined {
    let evicted: T | undefined;
    if (this._length === this.capacity) {
      evicted = this.buf[this.head];
      this.head = (this.head + 1) % this.capacity;
      this._length--;
    }
    this.buf[this.tail] = item;
    this.tail = (this.tail + 1) % this.capacity;
    this._length++;
    return evicted;
  }

  peek(): T | undefined {
    return this._length > 0 ? this.buf[this.head] : undefined;
  }

  pop(): T | undefined {
    if (this._length === 0) return undefined;
    const item = this.buf[this.head];
    this.buf[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this._length--;
    return item;
  }

  clear() {
    this.buf = new Array(this.capacity);
    this.head = 0;
    this.tail = 0;
    this._length = 0;
  }
}
