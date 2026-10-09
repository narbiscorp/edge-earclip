/*
 * session.ts — runs a guided protocol for real: clock, tones, speech,
 * device markers and the recording.
 *
 * Per event the runner reports:
 *   - the tone plays (already scheduled ahead when possible, see audio.ts)
 *     and a transition's instruction is spoken;
 *   - a NC_OP_MARKER goes to the earclip, so the label also lands in the
 *     device's EVENT stream on the device clock — the same clock as every
 *     raw PPG sample, which is what analysis should align on;
 *   - the event goes out on guidedBus for the recorder (protocol/*.csv).
 *
 * A recording is started if none is running and stopped at the end, so a
 * finished protocol always leaves one self-describing zip behind.
 */
import { narbisDevice } from '../ble/narbisDevice';
import { useDashboardStore } from '../state/store';
import { useRecordingStore } from '../state/recording';
import { GuidedAudio, type AudioMode } from './audio';
import { GUIDED_EVENT, guidedBus, type GuidedEventDetail } from './bus';
import { PROTOCOL_SCHEMA, type GuidedProtocol } from './protocol';
import { GuidedRunner, type EndReason, type GuidedEvent, type GuidedStatus } from './runner';

export interface GuidedSettings {
  subjectId: string;
  audioMode: AudioMode;
  notes: string;
}

export interface GuidedCounters {
  markersSent: number;
  markersFailed: number;
  lastMarkerError: string | null;
}

const TICK_MS = 50;
const LOOKAHEAD_MS = 250;
/** Spoken instruction starts after the announce tone has finished. */
const SAY_DELAY_MS = 450;

class GuidedSession {
  private runner: GuidedRunner | null = null;
  private audio = new GuidedAudio();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Date.now() - performance.now(), fixed at start: the runner runs on the
   * monotonic clock, the recording on the wall clock. */
  private epochOffset = 0;
  private startedRecording = false;

  protocol: GuidedProtocol | null = null;
  settings: GuidedSettings | null = null;
  outcome: EndReason | null = null;
  counters: GuidedCounters = { markersSent: 0, markersFailed: 0, lastMarkerError: null };
  lastCue: { prompt: string; atMs: number } | null = null;

  get active(): boolean {
    const p = this.runner?.currentPhase;
    return p === 'running' || p === 'paused';
  }

  status(): GuidedStatus | null {
    return this.runner ? this.runner.status() : null;
  }

  async testAudio(mode: AudioMode): Promise<void> {
    this.audio.mode = mode === 'off' ? 'tones' : mode;
    await this.audio.test();
  }

  /** Must be called from a click: audio can only start on a user gesture. */
  async start(protocol: GuidedProtocol, settings: GuidedSettings): Promise<void> {
    if (this.active) throw new Error('a guided recording is already running');
    this.protocol = protocol;
    this.settings = settings;
    this.outcome = null;
    this.lastCue = null;
    this.counters = { markersSent: 0, markersFailed: 0, lastMarkerError: null };
    this.audio.mode = settings.audioMode;
    await this.audio.unlock();

    const rec = useRecordingStore.getState();
    this.startedRecording = false;
    if (rec.phase !== 'RECORDING') {
      if (rec.phase === 'COMPLETE') rec.resetToIdle();
      await useRecordingStore.getState().startRecording({
        name: `Guided: ${protocol.title}`,
        subjectId: settings.subjectId,
        notes: `guided protocol ${protocol.id} v${protocol.version}` +
          `${settings.notes ? ` | ${settings.notes}` : ''}`,
        streams: {
          raw: true, beats: true, sqi: true, filtered: true, polar: true, acc: true, metrics: true,
        },
      });
      this.startedRecording = true;
    }

    this.epochOffset = Date.now() - performance.now();
    this.runner = new GuidedRunner(protocol, () => performance.now());
    this.handle(this.runner.start());
    this.timer = setInterval(() => this.loop(), TICK_MS);
  }

  pause(): void { if (this.runner) this.handle(this.runner.pause()); }
  resume(): void { if (this.runner) this.handle(this.runner.resume()); }
  skip(): void { if (this.runner) this.handle(this.runner.skip()); }
  abort(): void { if (this.runner) this.handle(this.runner.abort()); }

  /** Forget a finished session (the recording stays in the recorder). */
  reset(): void {
    if (this.active) return;
    this.runner = null;
    this.protocol = null;
    this.outcome = null;
  }

  private loop(): void {
    const r = this.runner;
    if (!r) return;
    this.handle(r.tick());
    for (const u of r.upcoming(LOOKAHEAD_MS)) {
      if (u.tone) this.audio.play(u.tone, u.atMs, u.key);
    }
  }

  private handle(evs: GuidedEvent[]): void {
    const r = this.runner;
    if (!r || !this.protocol) return;
    for (const ev of evs) {
      if (ev.tone && (ev.kind === 'block_start' || ev.kind === 'cue')) {
        this.audio.play(ev.tone, ev.tMs, r.soundKey(ev) ?? undefined);
      }
      if (ev.kind === 'block_start' && ev.say) {
        const text = ev.say;
        setTimeout(() => this.audio.say(text), SAY_DELAY_MS);
      }
      if (ev.kind === 'cue' && ev.prompt) {
        this.lastCue = { prompt: ev.prompt, atMs: ev.tMs };
      }

      let markerSentMs: number | null = null;
      if (ev.markerId !== undefined && narbisDevice.isV2) {
        markerSentMs = Date.now();
        void this.sendMarker(ev.markerId);
      }

      const detail: GuidedEventDetail = {
        ...ev,
        protocolId: this.protocol.id,
        hostMs: ev.tMs + this.epochOffset,
        markerSentMs,
        payload: ev.kind === 'session_start' ? this.describeSession() : undefined,
      };
      guidedBus.dispatchEvent(new CustomEvent(GUIDED_EVENT, { detail }));

      if (ev.kind === 'session_end') void this.finish(ev.reason ?? 'completed');
    }
  }

  private async sendMarker(id: number): Promise<void> {
    try {
      await narbisDevice.v2Marker(id);
      this.counters.markersSent += 1;
    } catch (err) {
      this.counters.markersFailed += 1;
      this.counters.lastMarkerError = err instanceof Error ? err.message : String(err);
    }
  }

  /** Everything needed to interpret the recording later, in the recording. */
  private describeSession(): unknown {
    const s = useDashboardStore.getState();
    return {
      schema: PROTOCOL_SCHEMA,
      protocol: this.protocol,
      settings: this.settings,
      started_at_iso: new Date().toISOString(),
      dashboard_build: typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : null,
      earclip: {
        connected: s.connection.narbis.state === 'connected',
        name: s.connection.narbis.deviceName,
        generation: narbisDevice.protocolVersion,
        firmware: narbisDevice.firmwareRevision,
        proto_version: narbisDevice.v2ProtoVersion,
      },
      reference_h10: {
        connected: s.connection.polar.state === 'connected',
        name: s.connection.polar.deviceName,
      },
      marker_scheme: 'id = (block_index + 1) * 1000 + (0 start | 999 end | 1 + cue_index)',
    };
  }

  private async finish(reason: EndReason): Promise<void> {
    this.outcome = reason;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    /* Let the final "done" tone and the last marker get out first. */
    await new Promise((res) => setTimeout(res, 1500));
    this.audio.stop();
    if (this.startedRecording && useRecordingStore.getState().phase === 'RECORDING') {
      await useRecordingStore.getState().stopRecording();
    }
    this.startedRecording = false;
  }
}

export const guidedSession = new GuidedSession();
