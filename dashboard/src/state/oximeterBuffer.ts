import { StreamBuffer } from './streamBuffer';
import type { OximeterReading } from '../ble/innovoOximeter';

/* The reference oximeter's once-a-second readings (ble/innovoOximeter.ts): an hour of them, beside
 * the earclip's SpO2 estimates (spo2Buffer.ts). Live only for now: recordings keep them
 * (reference_oximeter/), replay does not read them back yet. */
export const oximeterBuffers = {
  live: new StreamBuffer<OximeterReading>(3600),
  replay: new StreamBuffer<OximeterReading>(3600),
};
