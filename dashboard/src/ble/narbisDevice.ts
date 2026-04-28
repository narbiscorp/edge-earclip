// TODO Stage 10: implement Web Bluetooth connection to the Narbis earclip.

export class NarbisDevice {
  async connect(): Promise<void> {
    throw new Error('not implemented');
  }

  async disconnect(): Promise<void> {
    throw new Error('not implemented');
  }
}

export const narbisDevice = new NarbisDevice();
