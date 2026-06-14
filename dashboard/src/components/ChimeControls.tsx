import { useDashboardStore } from '../state/store';
import { CHIME_VOICES, CHIME_VOICE_LABEL, playChime, unlockAudio, type ChimeVoice } from '../audio/chime';

/* ChimeControls — on/off toggle + per-direction sound picker for the breathing-pacer chime.
 * Audio needs a user gesture to start, so we unlock (and preview) on every click here. */
export default function ChimeControls() {
  const enabled = useDashboardStore((s) => s.chimeEnabled);
  const setEnabled = useDashboardStore((s) => s.setChimeEnabled);
  const inhale = useDashboardStore((s) => s.chimeInhale);
  const exhale = useDashboardStore((s) => s.chimeExhale);
  const setInhale = useDashboardStore((s) => s.setChimeInhale);
  const setExhale = useDashboardStore((s) => s.setChimeExhale);

  const toggle = () => {
    const next = !enabled;
    if (next) {
      unlockAudio();
      playChime(inhale, 'inhale'); // preview + unlock the AudioContext on enable
    }
    setEnabled(next);
  };

  return (
    <section className="rounded-xl border border-slate-800/80 bg-slate-900/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] tracking-[0.18em] uppercase text-slate-400">Breathing chime</div>
        <button
          type="button"
          onClick={toggle}
          className={
            'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition ' +
            (enabled
              ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-200'
              : 'border-slate-700 bg-slate-800/60 text-slate-400 hover:text-slate-200')
          }
          title="Play a soft tone on each inhale and exhale"
        >
          <span className={'h-1.5 w-1.5 rounded-full ' + (enabled ? 'bg-emerald-400' : 'bg-slate-500')} />
          {enabled ? 'On' : 'Off'}
        </button>
      </div>
      {enabled ? (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <VoicePicker label="Inhale" value={inhale} onChange={setInhale} dir="inhale" />
          <VoicePicker label="Exhale" value={exhale} onChange={setExhale} dir="exhale" />
        </div>
      ) : (
        <div className="mt-1 text-[11px] text-slate-500">
          A soft tone on each inhale and exhale to pace your breathing. Plays while a breathing
          program or Mode A/B is running.
        </div>
      )}
    </section>
  );
}

function VoicePicker({
  label, value, onChange, dir,
}: {
  label: string;
  value: ChimeVoice;
  onChange: (v: ChimeVoice) => void;
  dir: 'inhale' | 'exhale';
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className="flex items-center gap-1">
        <select
          value={value}
          onChange={(e) => {
            const v = e.target.value as ChimeVoice;
            onChange(v);
            unlockAudio();
            playChime(v, dir);
          }}
          className="flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-100"
        >
          {CHIME_VOICES.map((v) => (
            <option key={v} value={v}>{CHIME_VOICE_LABEL[v]}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => { unlockAudio(); playChime(value, dir); }}
          title={`Preview the ${label.toLowerCase()} sound`}
          className="rounded border border-slate-700 bg-slate-800/60 hover:bg-slate-700 px-2 py-1 text-[11px] text-slate-300"
        >
          ▶
        </button>
      </div>
    </div>
  );
}
