import { useDashboardStore } from '../state/store';
import {
  NARBIS_BEAT_FLAG_ARTIFACT,
  NARBIS_BEAT_FLAG_LOW_SQI,
  NARBIS_BEAT_FLAG_INTERPOLATED,
  NARBIS_BEAT_FLAG_LOW_CONFIDENCE,
} from '../ble/parsers';

function decodeFlags(flags: number): string {
  const parts: string[] = [];
  if (flags & NARBIS_BEAT_FLAG_ARTIFACT) parts.push('artifact');
  if (flags & NARBIS_BEAT_FLAG_LOW_SQI) parts.push('low_sqi');
  if (flags & NARBIS_BEAT_FLAG_INTERPOLATED) parts.push('interpolated');
  if (flags & NARBIS_BEAT_FLAG_LOW_CONFIDENCE) parts.push('low_conf');
  return parts.length ? parts.join(',') : 'clean';
}

export default function DebugPanel() {
  const counters = useDashboardStore((s) => s.counters);
  const lastBeat = useDashboardStore((s) => s.lastBeat);
  const lastSqi = useDashboardStore((s) => s.lastSqi);
  const battery = useDashboardStore((s) => s.connection.narbis.battery);

  return (
    <div className="flex items-center gap-4 text-[11px] font-mono text-slate-300">
      <Stat label="beats" value={counters.beats} />
      <Stat label="raw" value={counters.rawSamples} />
      <Stat label="sqi" value={counters.sqi} />
      <Stat label="polar" value={counters.polarBeats} />
      <span className="text-slate-600">|</span>
      <Stat
        label="last IBI"
        value={lastBeat ? `${lastBeat.ibi_ms}ms` : '—'}
      />
      <Stat
        label="BPM"
        value={lastBeat ? lastBeat.bpm : '—'}
      />
      <Stat
        label="SQI"
        value={lastSqi ? (lastSqi.sqi_x100 / 100).toFixed(2) : '—'}
      />
      <Stat
        label="flags"
        value={lastBeat ? decodeFlags(lastBeat.flags) : '—'}
      />
      <Stat
        label="batt"
        value={battery !== null ? `${battery}%` : '—'}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <span>
      <span className="text-slate-500">{label}:</span> <span className="text-slate-100">{value}</span>
    </span>
  );
}
