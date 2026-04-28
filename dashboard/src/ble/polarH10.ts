// TODO Stage 10: implement Polar H10 reference connection (Heart Rate Service 0x180D).

export class PolarH10 {
  async connect(): Promise<void> {
    throw new Error('not implemented');
  }

  async disconnect(): Promise<void> {
    throw new Error('not implemented');
  }
}

export const polarH10 = new PolarH10();
