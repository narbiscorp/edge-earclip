// TODO Stage 11: ring buffer for raw PPG / IBI streams feeding the charts.

export class StreamBuffer<T> {
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  push(_item: T): void {
    throw new Error('not implemented');
  }

  take(_n: number): T[] {
    throw new Error('not implemented');
  }

  clear(): void {
    throw new Error('not implemented');
  }

  size(): number {
    return 0;
  }

  getCapacity(): number {
    return this.capacity;
  }
}
