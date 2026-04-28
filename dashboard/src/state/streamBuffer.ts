export interface StreamSample<T> {
  timestamp: number;
  value: T;
}

export class StreamBuffer<T> {
  readonly capacity: number;
  private readonly timestamps: Float64Array;
  private readonly values: Array<T | undefined>;
  private head = 0;
  private count = 0;

  constructor(capacity: number) {
    if (capacity <= 0) throw new Error(`capacity must be positive, got ${capacity}`);
    this.capacity = capacity;
    this.timestamps = new Float64Array(capacity);
    this.values = new Array<T | undefined>(capacity);
  }

  push(timestamp: number, value: T): void {
    this.timestamps[this.head] = timestamp;
    this.values[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count += 1;
  }

  getWindow(seconds: number): StreamSample<T>[] {
    if (this.count === 0) return [];
    const cutoff = this.latestTimestamp() - seconds * 1000;
    const out: StreamSample<T>[] = [];
    const start = (this.head - this.count + this.capacity) % this.capacity;
    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.capacity;
      const ts = this.timestamps[idx];
      if (ts >= cutoff) {
        out.push({ timestamp: ts, value: this.values[idx] as T });
      }
    }
    return out;
  }

  getAll(): StreamSample<T>[] {
    const out: StreamSample<T>[] = [];
    if (this.count === 0) return out;
    const start = (this.head - this.count + this.capacity) % this.capacity;
    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.capacity;
      out.push({ timestamp: this.timestamps[idx], value: this.values[idx] as T });
    }
    return out;
  }

  latest(): StreamSample<T> | null {
    if (this.count === 0) return null;
    const idx = (this.head - 1 + this.capacity) % this.capacity;
    return { timestamp: this.timestamps[idx], value: this.values[idx] as T };
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }

  size(): number {
    return this.count;
  }

  private latestTimestamp(): number {
    const idx = (this.head - 1 + this.capacity) % this.capacity;
    return this.timestamps[idx];
  }
}
