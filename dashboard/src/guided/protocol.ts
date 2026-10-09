/*
 * protocol.ts — guided recording protocols (shared definition).
 *
 * The protocols live in ../../../protocol/guided/ppg_artifact_protocols.json
 * so the dashboard, Android and iOS run byte-identical scripts: every block
 * is written out in full (transitions included), there is nothing to
 * expand or rotate, and a platform only has to walk the list. This module
 * types that file, validates it, and owns the two derived rules every
 * platform must agree on: when cues fire, and how markers are numbered.
 */
import raw from '../../../protocol/guided/ppg_artifact_protocols.json';

export const PROTOCOL_SCHEMA = 'narbis.guided-protocol/1';

/** settle / transition blocks are never training data; state blocks label
 * their whole span (minus drop_lead_s); cued blocks label the instants. */
export type BlockKind = 'settle' | 'transition' | 'state' | 'cued';

export interface GuidedCue {
  every_s: number;
  /** Cycled per cue: ["Turn left", "Turn right"] alternates. */
  prompts: string[];
  /** Cycled per cue; empty = no sound. */
  tones?: string[];
  /** The cued action spans [cue + lead_s, cue + tail_s]. */
  lead_s: number;
  tail_s: number;
  /** false = pacing guidance (paced breathing), not a labelled event. */
  marks_event: boolean;
}

export interface GuidedBlock {
  label: string;
  kind: BlockKind;
  seconds: number;
  /** On-screen instruction. */
  prompt: string;
  /** Spoken at the block start when speech is on (transitions carry it). */
  say?: string;
  /** Tone at the block start. */
  tone?: string;
  posture?: string;
  cue?: GuidedCue;
}

export interface GuidedProtocol {
  id: string;
  version: number;
  title: string;
  summary: string;
  reference: string;
  /** Training hint: drop this many seconds at the start of labelled blocks
   * (compliance ramp after the go tone). Not applied while recording. */
  drop_lead_s: number;
  check_only?: boolean;
  blocks: GuidedBlock[];
}

export interface GuidedProtocolFile {
  schema: string;
  about: string;
  tones: Record<string, string>;
  protocols: GuidedProtocol[];
}

export const GUIDED_FILE = raw as GuidedProtocolFile;
export const GUIDED_PROTOCOLS: GuidedProtocol[] = GUIDED_FILE.protocols;

export function findProtocol(id: string): GuidedProtocol | undefined {
  return GUIDED_PROTOCOLS.find((p) => p.id === id);
}

export function protocolSeconds(p: GuidedProtocol): number {
  return p.blocks.reduce((a, b) => a + b.seconds, 0);
}

/** Cue offsets from the block start, in seconds. The first cue comes one
 * interval in (never on top of the go tone), and a cue only fires if the
 * action it asks for (tail_s) still ends inside the block. */
export function cueTimes(block: GuidedBlock): number[] {
  const c = block.cue;
  if (!c || c.every_s <= 0) return [];
  const out: number[] = [];
  for (let k = 1; ; k++) {
    const t = Math.round(k * c.every_s * 1000) / 1000;
    if (t + c.tail_s > block.seconds + 1e-9) break;
    out.push(t);
  }
  return out;
}

/* ---- device markers ---------------------------------------------------
 * Every block boundary and cue is also sent to the earclip as a
 * NC_OP_MARKER, so the label lands in the device's own EVENT stream with
 * a device-clock timestamp — the same clock as every raw PPG sample.
 *   id = (block_index + 1) * 1000 + offset
 *   offset 0 = block start, 999 = block end, 1..998 = cue number (1-based)
 * u16 on the wire, so at most MAX_BLOCKS blocks per protocol. */
export const MAX_BLOCKS = 60;
export const MARKER_END = 999;

export function markerId(blockIndex: number, kind: 'start' | 'end' | 'cue', cueIndex = 0): number {
  const base = (blockIndex + 1) * 1000;
  if (kind === 'start') return base;
  if (kind === 'end') return base + MARKER_END;
  return base + 1 + cueIndex;            /* cueIndex is 0-based */
}

export function decodeMarkerId(
  id: number,
): { blockIndex: number; kind: 'start' | 'end' | 'cue'; cueIndex: number } | null {
  if (!Number.isInteger(id) || id < 1000 || id > 0xffff) return null;
  const blockIndex = Math.floor(id / 1000) - 1;
  const off = id % 1000;
  if (off === 0) return { blockIndex, kind: 'start', cueIndex: -1 };
  if (off === MARKER_END) return { blockIndex, kind: 'end', cueIndex: -1 };
  return { blockIndex, kind: 'cue', cueIndex: off - 1 };
}

/* ---- validation ---------------------------------------------------------
 * The file is shared with the apps; a malformed edit must fail a test, not
 * a participant halfway through a recording. Returns human-readable
 * problems, empty when the file is good. */
const KINDS: BlockKind[] = ['settle', 'transition', 'state', 'cued'];

export function validateProtocolFile(f: GuidedProtocolFile): string[] {
  const errs: string[] = [];
  if (f.schema !== PROTOCOL_SCHEMA) errs.push(`schema "${f.schema}" != "${PROTOCOL_SCHEMA}"`);
  const ids = new Set<string>();
  for (const p of f.protocols) {
    const at = `protocol ${p.id}`;
    if (!p.id || ids.has(p.id)) errs.push(`${at}: missing or duplicate id`);
    ids.add(p.id);
    if (!Number.isInteger(p.version) || p.version < 1) errs.push(`${at}: version must be an integer >= 1`);
    if (!p.blocks.length) errs.push(`${at}: no blocks`);
    if (p.blocks.length > MAX_BLOCKS) errs.push(`${at}: ${p.blocks.length} blocks > ${MAX_BLOCKS} (marker ids are u16)`);
    if (!(p.drop_lead_s >= 0)) errs.push(`${at}: drop_lead_s must be >= 0`);
    p.blocks.forEach((b, i) => {
      const bat = `${at} block ${i} (${b.label})`;
      if (!b.label) errs.push(`${bat}: empty label`);
      if (!KINDS.includes(b.kind)) errs.push(`${bat}: unknown kind "${b.kind}"`);
      if (!(b.seconds > 0)) errs.push(`${bat}: seconds must be > 0`);
      if (!b.prompt) errs.push(`${bat}: empty prompt`);
      if (b.tone && !(b.tone in f.tones)) errs.push(`${bat}: unknown tone "${b.tone}"`);
      if ((b.kind === 'settle' || b.kind === 'transition') && b.cue) {
        errs.push(`${bat}: ${b.kind} blocks must not carry cues`);
      }
      if (b.kind === 'cued' && (!b.cue || !b.cue.marks_event)) {
        errs.push(`${bat}: cued blocks need a cue with marks_event = true`);
      }
      if (b.cue) {
        const c = b.cue;
        if (!(c.every_s > 0)) errs.push(`${bat}: cue.every_s must be > 0`);
        if (!c.prompts.length) errs.push(`${bat}: cue.prompts is empty`);
        if (!(c.tail_s >= c.lead_s && c.lead_s >= 0)) errs.push(`${bat}: need 0 <= lead_s <= tail_s`);
        for (const t of c.tones ?? []) {
          if (!(t in f.tones)) errs.push(`${bat}: unknown cue tone "${t}"`);
        }
        const n = cueTimes(b).length;
        if (n === 0) errs.push(`${bat}: no cue fits inside the block`);
        if (n > MARKER_END - 1) errs.push(`${bat}: ${n} cues overflow the marker offset`);
      }
    });
  }
  return errs;
}
