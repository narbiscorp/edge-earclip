import JSZip from 'jszip';
import { getDb, STORE_RECORDING_SESSIONS, STORE_RECORDING_BLOBS } from '../state/idb';
import {
  buildReplayEvents,
  concatStream,
  loadChunks,
  alignH10ToEarclip,
} from './aggregator';
import {
  FILE_NAMES,
  OXIMETER_README,
  V2_README,
  writeAccSamplesCSV,
  writeAnnotationsCSV,
  writeBatteryCSV,
  writeBeatsCSV,
  writeBleLogTxt,
  writeComparisonCSV,
  writeConfigHistoryJSON,
  writeH10BeatsCSV,
  writeH10MetricsCSV,
  writeManifestJSON,
  writeMetricsCSV,
  writeOximeterCSV,
  writeOximeterPlethCSV,
  writeRawSamplesCSV,
  writeReplayJSON,
  writeV2AccelRawCSV,
  writeV2EventsCSV,
  writeV2IbiCSV,
  writeV2LinkStatsJSON,
  writeV2PpgRawCSV,
  writeV2StatusCSV,
} from './format';
import { buildManifest, sessionFolderName, summarize } from './manifest';
import {
  PROTOCOL_README,
  buildBlockRows,
  markerDeviceTimes,
  protocolOf,
  writeProtocolBlocksCSV,
  writeProtocolCuesCSV,
  writeProtocolJSON,
} from './protocolFormat';
import type {
  AccPacketRecord,
  Annotation,
  BatteryRecord,
  BeatRecord,
  ConfigChangeEntry,
  FileEntry,
  ManifestSummary,
  MetricsRecord,
  PolarBeatRecordTimed,
  RawSampleRecord,
  RecordingSessionRow,
  SqiRecord,
} from './types';

export interface ExportResult {
  blob: Blob;
  filename: string;
  summary: ManifestSummary;
}

async function readSessionRow(sessionId: string): Promise<RecordingSessionRow | null> {
  const db = await getDb();
  const row = (await db.get(STORE_RECORDING_SESSIONS, sessionId)) as
    | RecordingSessionRow
    | undefined;
  return row ?? null;
}

export async function exportSession(sessionId: string): Promise<ExportResult> {
  const session = await readSessionRow(sessionId);
  if (!session) throw new Error(`session ${sessionId} not found`);

  const chunks = await loadChunks(sessionId);
  const raw = concatStream(chunks, 'raw') as RawSampleRecord[];
  const beats = concatStream(chunks, 'beats') as BeatRecord[];
  const sqi = concatStream(chunks, 'sqi') as SqiRecord[];
  const battery = concatStream(chunks, 'battery') as BatteryRecord[];
  const polarBeats = concatStream(chunks, 'polarBeats') as PolarBeatRecordTimed[];
  const accPackets = concatStream(chunks, 'accPackets') as AccPacketRecord[];
  const metrics = concatStream(chunks, 'metrics') as MetricsRecord[];
  const annotations = concatStream(chunks, 'annotations') as Annotation[];
  const configEvents = concatStream(chunks, 'configEvents') as ConfigChangeEntry[];

  const replayEvents = buildReplayEvents(chunks);

  const folder = sessionFolderName(session);
  const zip = new JSZip();
  const root = zip.folder(folder);
  if (!root) throw new Error('failed to create zip folder');

  const files: FileEntry[] = [];

  function add(path: string, content: string): void {
    root!.file(path, content);
    files.push({ path, bytes: byteLengthUtf8(content) });
  }

  if (session.streams.raw) add(FILE_NAMES.rawSamples, writeRawSamplesCSV(raw));
  if (session.streams.beats) add(FILE_NAMES.beats, writeBeatsCSV(beats));
  if (session.streams.metrics) add(FILE_NAMES.metrics, writeMetricsCSV(metrics));
  if (battery.length > 0) add(FILE_NAMES.battery, writeBatteryCSV(battery));
  add(FILE_NAMES.annotations, writeAnnotationsCSV(annotations));
  add(FILE_NAMES.configHistory, writeConfigHistoryJSON(configEvents));
  add(FILE_NAMES.replay, writeReplayJSON(replayEvents));

  const hasH10 = session.streams.polar && polarBeats.length > 0;
  if (hasH10) {
    add(FILE_NAMES.h10Beats, writeH10BeatsCSV(polarBeats));
    add(FILE_NAMES.h10Metrics, writeH10MetricsCSV([]));
    const comparison = alignH10ToEarclip(beats, polarBeats);
    add(FILE_NAMES.comparison, writeComparisonCSV(comparison));
  }
  if (session.streams.acc && accPackets.length > 0) {
    add(FILE_NAMES.accSamples, writeAccSamplesCSV(accPackets));
  }

  /* V2.1 (AFE4404) full-fidelity capture — only present when a V2 board
   * streamed during the recording. */
  const v2Ppg = concatStream(chunks, 'v2Ppg');
  const v2Accel = concatStream(chunks, 'v2Accel');
  const v2Status = concatStream(chunks, 'v2Status');
  const v2Ibi = concatStream(chunks, 'v2Ibi');
  const v2Events = concatStream(chunks, 'v2Events');
  if (v2Ppg.length > 0 || v2Ibi.length > 0 || v2Status.length > 0) {
    if (v2Ppg.length > 0) add(FILE_NAMES.v2PpgRaw, writeV2PpgRawCSV(v2Ppg));
    if (v2Accel.length > 0) add(FILE_NAMES.v2AccelRaw, writeV2AccelRawCSV(v2Accel));
    if (v2Status.length > 0) add(FILE_NAMES.v2Status, writeV2StatusCSV(v2Status));
    if (v2Ibi.length > 0) add(FILE_NAMES.v2Ibi, writeV2IbiCSV(v2Ibi));
    if (v2Events.length > 0) add(FILE_NAMES.v2Events, writeV2EventsCSV(v2Events));
    add(FILE_NAMES.v2LinkStats, writeV2LinkStatsJSON({
      fwVersion: session.fwVersion,
      batches: v2Ppg, accel: v2Accel, ibis: v2Ibi, statuses: v2Status, events: v2Events,
    }));
    add(FILE_NAMES.v2Readme, V2_README);
  }
  /* Reference pulse oximeter — present when one was connected while recording. */
  const oximeter = concatStream(chunks, 'oximeter');
  const oximeterPleth = concatStream(chunks, 'oximeterPleth');
  if (oximeter.length > 0) {
    add(FILE_NAMES.oximeter, writeOximeterCSV(oximeter));
    if (oximeterPleth.length > 0) add(FILE_NAMES.oximeterPleth, writeOximeterPlethCSV(oximeterPleth));
    add(FILE_NAMES.oximeterReadme, OXIMETER_README);
  }
  /* Guided protocol labels — present when the recording ran a protocol. */
  const protocolEvents = concatStream(chunks, 'protocolEvents');
  if (protocolEvents.length > 0) {
    const devTimes = markerDeviceTimes(protocolEvents, v2Events);
    const def = protocolOf(protocolEvents);
    const rows = buildBlockRows(protocolEvents, devTimes, def);
    add(FILE_NAMES.protocolJson, writeProtocolJSON(protocolEvents, rows, devTimes));
    add(FILE_NAMES.protocolBlocks, writeProtocolBlocksCSV(rows));
    add(FILE_NAMES.protocolCues, writeProtocolCuesCSV(protocolEvents, devTimes, def));
    add(FILE_NAMES.protocolReadme, PROTOCOL_README);
  }
  const bleLog = concatStream(chunks, 'bleLog');
  if (bleLog.length > 0) add(FILE_NAMES.bleLog, writeBleLogTxt(bleLog));

  const endedAt = session.endedAt ?? Date.now();

  const filesBytes = files.reduce((acc, f) => acc + f.bytes, 0);
  const summary = summarize({
    startedAt: session.startedAt,
    endedAt,
    raw,
    beats,
    sqi,
    annotations,
    polarBeats,
    metrics,
    filesBytes,
  });

  const manifest = buildManifest(session, endedAt, files, summary);
  add(FILE_NAMES.manifest, writeManifestJSON(manifest));

  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const filename = `${folder}.zip`;
  return { blob, filename, summary };
}

export async function loadStoredBlob(sessionId: string): Promise<Blob | null> {
  const db = await getDb();
  const row = (await db.get(STORE_RECORDING_BLOBS, sessionId)) as
    | { id: string; blob: Blob }
    | undefined;
  return row?.blob ?? null;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function saveBlobWithPicker(
  blob: Blob,
  suggestedName: string,
): Promise<boolean> {
  // Feature-detect File System Access API; fall back to anchor download.
  const w = window as unknown as {
    showSaveFilePicker?: (opts: {
      suggestedName: string;
      types: Array<{ description: string; accept: Record<string, string[]> }>;
    }) => Promise<{
      createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }>;
    }>;
  };
  if (typeof w.showSaveFilePicker !== 'function') {
    downloadBlob(blob, suggestedName);
    return true;
  }
  try {
    const handle = await w.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return false;
    downloadBlob(blob, suggestedName);
    return true;
  }
}

function byteLengthUtf8(s: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(s).byteLength;
  }
  // Fallback: rough estimate (each char ≈ 1 byte for ASCII).
  return s.length;
}
