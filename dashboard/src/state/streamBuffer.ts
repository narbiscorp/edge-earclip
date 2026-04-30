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
  // Monotonic write counter — chart render loops compare against the last
  // value they consumed and skip Plotly.react when nothing has changed.
  private _seq = 0;

  constructor(capacity: number) {
    if (capacity <= 0) throw new Error(`capacity must be positive, got ${capacity}`);
    this.capacity = capacity;
    this.timestamps = new Float64Array(capacity);
    this.values = new Array<T | undefined>(capacity);
  }

  get seq(): number {
    return this._seq;
  }

  push(timestamp: number, value: T): void {
    this.timestamps[this.head] = timestamp;
    this.values[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count += 1;
    this._seq++;
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

  // Zero-allocation window iterator. The callback receives raw values and
  // an output index so chart pulls can fill caller-owned typed arrays
  // without first materialising a `StreamSample[]` per frame.
  forEachInWindow(
    seconds: number,
    cb: (timestamp: number, value: T, index: number) => void,
  ): number {
    if (this.count === 0) return 0;
    const cutoff = this.latestTimestamp() - seconds * 1000;
    const start = (this.head - this.count + this.capacity) % this.capacity;
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      const idx = (start + i) % this.capacity;
      const ts = this.timestamps[idx];
      if (ts >= cutoff) {
        cb(ts, this.values[idx] as T, n);
        n++;
      }
    }
    return n;
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
    // Bump seq so chart consumers re-render the cleared state.
    this._seq++;
  }

  size(): number {
    return this.count;
  }

  private latestTimestamp(): number {
    const idx = (this.head - 1 + this.capacity) % this.capacity;
    return this.timestamps[idx];
  }
}
