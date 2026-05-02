import { useEffect, useState } from 'react';
import { useDashboardStore } from '../state/store';
import {
  edgeDevice,
  type CoherenceDifficulty,
  type PpgProgram,
} from '../ble/edgeDevice';

/* EdgeControls
 *
 * Mirrors the v13.27 dashboard's "Coherence Difficulty / Lens / Strobe /
 * Breathing Pacer / Adaptive Pacer / ADC Scan" controls. Each control
 * sends its opcode to the glasses CTRL char (0xFF01) on commit and is
 * disabled when the glasses are not connected. Sliders fire on
 * mouseup/touchend so we don't spam BLE during drag.
 */
export default function EdgeControls() {
  const edgeState = useDashboardStore((s) => s.connection.edge.state);
  const connected = edgeState === 'connected';
  const jitter    = useDashboardStore((s) => s.pcJitterSmoothing);
  const setJitter = useDashboardStore((s) => s.setPcJitterSmoothing);

  // Local UI state — these mirror what we last pushed to the firmware.
  // We don't have a read-back path for most, so they default sensibly
  // and the user adjusts. Persisted-on-firmware values survive reboot.
  const [program, setProgram]       = useState<PpgProgram | null>(null);
  const [standalone, setStandalone] = useState<'static' | 'strobe' | 'breathe' | 'pulse' | null>(null);
  const [staticDuty, setStaticDuty] = useState(50);
  const [difficulty, setDifficulty] = useState<CoherenceDifficulty>('easy');
  const [lensLimit, setLensLimit]   = useState(100);
  const [strobeFreq, setStrobeFreq] = useState(10);
  const [strobeDuty, setStrobeDuty] = useState(50);
  const [breathBpm, setBreathBpm]   = useState(6);
  const [inhalePct, setInhalePct]   = useState(40);
  const [adaptive, setAdaptive]     = useState(false);
  /* Raw relay is auto-enabled in store.ts on every glasses connect.
   * This local state mirrors that so the toggle reflects reality; it
   * also resets to true on each reconnect so a user who toggled it off
   * gets a fresh enable on the next session. */
  const [rawRelay, setRawRelay]     = useState(true);
  const [busy, setBusy]             = useState<string | null>(null);

  useEffect(() => {
    if (connected) {
      setBusy(null);
      setRawRelay(true);
    }
  }, [connected]);

  const guard = (label: string, fn: () => Promise<void>) => async () => {
    setBusy(label);
    try { await fn(); } catch (e) { console.error(label, e); }
    finally { setBusy(null); }
  };

  return (
    <div className="rounded bg-slate-900/70 border border-slate-700 p-3 text-xs space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-slate-200 font-medium">Edge Controls</span>
        <span className={connected ? 'text-emerald-400' : 'text-slate-500'}>
          {connected ? 'connected' : 'disconnected — connect glasses to enable'}
        </span>
        {busy && <span className="text-slate-500 text-[10px]">{busy}…</span>}
      </div>

      {/* Sensor-training programs — require an earclip paired with the
          glasses (or the on-glasses ADC pin). Without a beat source the
          glasses just sit in training mode and produce no lens output. */}
      <Section
        label="Training Programs (sensor mode, 0xB7)"
        hint="Requires a paired earclip OR the internal ADC sensor enabled. Each program drives the lens off live IBI / coherence."
      >
        <div className="grid grid-cols-4 gap-1">
          {([1, 2, 3, 4] as PpgProgram[]).map((p) => (
            <button
              key={p}
              disabled={!connected}
              onClick={guard('program', async () => {
                setProgram(p);
                setStandalone(null);
                await edgeDevice.setProgram(p);
              })}
              className={btnClass(program === p)}
            >
              Prog {p}
            </button>
          ))}
        </div>
        <div className="text-[10px] text-slate-500 mt-1">
          1=heartbeat • 2=coh breathe • 3=coh lens • 4=coh breathe+strobe
        </div>
      </Section>

      {/* Standalone modes — work with NO sensor. Useful for exercising
          the lens / strobe driver without a heart-rate source. Each
          replaces whatever training program was active. */}
      <Section
        label="Standalone Modes (no sensor needed)"
        hint="Direct lens driver control. Doesn't read PPG / IBI. Use these for testing the optics without the earclip."
      >
        <div className="grid grid-cols-2 gap-1">
          <button
            disabled={!connected}
            onClick={guard('standalone strobe', async () => {
              setStandalone('strobe');
              setProgram(null);
              await edgeDevice.setStandaloneStrobe();
            })}
            className={btnClass(standalone === 'strobe')}
          >
            Strobe (0xA6)
          </button>
          <button
            disabled={!connected}
            onClick={guard('standalone breathe', async () => {
              setStandalone('breathe');
              setProgram(null);
              await edgeDevice.setStandaloneBreathe();
            })}
            className={btnClass(standalone === 'breathe')}
          >
            Breathe (0xB0)
          </button>
          <button
            disabled={!connected}
            onClick={guard('standalone pulse', async () => {
              setStandalone('pulse');
              setProgram(null);
              await edgeDevice.setStandalonePulseOnBeat();
            })}
            className={btnClass(standalone === 'pulse')}
          >
            Pulse on beat (0xB6)
          </button>
          <button
            disabled={!connected}
            onClick={guard('standalone static', async () => {
              setStandalone('static');
              setProgram(null);
              await edgeDevice.setStandaloneStatic(staticDuty);
            })}
            className={btnClass(standalone === 'static')}
          >
            Static (0xA5)
          </button>
        </div>
        {standalone === 'static' && (
          <div className="mt-2">
            <Slider
              label="Static duty"
              unit="%"
              min={0} max={100} step={1}
              value={staticDuty}
              onChange={setStaticDuty}
              onCommit={(v) => edgeDevice.setStandaloneStatic(v).catch(console.error)}
              disabled={!connected}
            />
          </div>
        )}
        <div className="text-[10px] text-slate-500 mt-1">
          Strobe and Breathe also use the Strobe Frequency / Strobe Duty
          and Breathing Pacer sliders below. Static uses its own duty
          slider above.
        </div>
      </Section>

      {/* Difficulty */}
      <Section label="Coherence Difficulty (0xB8)">
        <div className="grid grid-cols-4 gap-1">
          {(['easy', 'medium', 'hard', 'expert'] as CoherenceDifficulty[]).map((d) => (
            <button
              key={d}
              disabled={!connected}
              onClick={guard('difficulty', async () => {
                setDifficulty(d);
                await edgeDevice.setDifficulty(d);
              })}
              className={btnClass(difficulty === d)}
            >
              {d.charAt(0).toUpperCase() + d.slice(1)}
            </button>
          ))}
        </div>
      </Section>

      {/* Lens darkness limit */}
      <Slider
        label="Lens Darkness Limit (0xA2)"
        unit="%"
        min={0} max={100} step={1}
        value={lensLimit}
        onChange={setLensLimit}
        onCommit={(v) => edgeDevice.setLensLimitPct(v).catch(console.error)}
        disabled={!connected}
        help="Caps maximum tint for breathing/coherence programs (Programs 1–3)."
      />

      {/* Strobe */}
      <Slider
        label="Strobe Frequency (0xAB)"
        unit="Hz"
        min={1} max={50} step={1}
        value={strobeFreq}
        onChange={setStrobeFreq}
        onCommit={(v) => edgeDevice.setStrobeFreqHz(v).catch(console.error)}
        disabled={!connected}
        help="Flash rate for Program 4 and standalone strobe."
      />
      <Slider
        label="Strobe Duty Cycle (0xAC)"
        unit="%"
        min={10} max={90} step={1}
        value={strobeDuty}
        onChange={setStrobeDuty}
        onCommit={(v) => edgeDevice.setStrobeDutyPct(v).catch(console.error)}
        disabled={!connected}
        help="Dark fraction per strobe cycle (10–90%)."
      />

      {/* Breathing pacer */}
      <Slider
        label="Breathing Pacer Rate (0xB1)"
        unit="br/min"
        min={4} max={20} step={1}
        value={breathBpm}
        onChange={setBreathBpm}
        onCommit={(v) => edgeDevice.setBreathRateBpm(v).catch(console.error)}
        disabled={!connected}
        help="Fixed-rate breathing for Breathe program and Program 4 when adaptive is OFF."
      />
      <Slider
        label="Inhale Ratio (0xB2)"
        unit="%"
        min={30} max={70} step={1}
        value={inhalePct}
        onChange={setInhalePct}
        onCommit={(v) => edgeDevice.setBreathInhalePct(v).catch(console.error)}
        disabled={!connected}
        help={`Inhale fraction; ${inhalePct}% inhale / ${100 - inhalePct}% exhale.`}
      />

      {/* Adaptive pacer */}
      <Section label="Adaptive Pacer (0xB9)">
        <Toggle
          checked={adaptive}
          disabled={!connected}
          onChange={(on) => {
            setAdaptive(on);
            void edgeDevice.setAdaptivePacer(on).catch(console.error);
          }}
          label="Track measured respiration (Programs 2 & 4)"
          help={
            'When ON, pacer starts at 6 br/min and adapts toward measured ' +
            'respiration each cycle. Doesn\'t affect Programs 1/3.'
          }
        />
      </Section>

      {/* Raw PPG relay through the glasses (Path B Phase 2) */}
      <Section label="Stream Raw PPG via glasses (0xC4)">
        <Toggle
          checked={rawRelay}
          disabled={!connected}
          onChange={(on) => {
            setRawRelay(on);
            void edgeDevice.setRawRelayEnabled(on).catch(console.error);
          }}
          label={rawRelay ? 'Raw PPG relay enabled (forwards 0xF5 frames)' : 'Raw PPG relay disabled'}
          help={
            'Tells the glasses to subscribe to the earclip\'s RAW_PPG ' +
            'characteristic and forward each batch as a 0xF5 status ' +
            'frame. Adds significant BLE air-time and earclip power; ' +
            'leave OFF unless actively diagnosing the raw signal. The ' +
            'IBI / battery / config relay paths run regardless.'
          }
        />
      </Section>

      {/* PC jitter smoothing toggle (dashboard-side, not a BLE control) */}
      <Section label="PC Jitter Smoothing (dashboard)">
        <Toggle
          checked={jitter}
          disabled={false}
          onChange={setJitter}
          label="Enable (150 ms buffer)"
          help={
            'For PC only. Buffers incoming raw-PPG BLE packets 150 ms and ' +
            'replays at uniform 20 ms intervals. Smooths Windows BLE bursty ' +
            'delivery. Adds 150 ms latency. Leave OFF on tablet.'
          }
        />
      </Section>

      {/* Maintenance */}
      <Section label="Maintenance">
        <div className="flex flex-wrap gap-2">
          <button
            className="rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-50 px-2 py-1"
            disabled={!connected}
            onClick={guard('detector reset', () => edgeDevice.detectorReset())}
            title="Reset firmware detector state (0xD0)"
          >
            Reset detector
          </button>
          <button
            className="rounded bg-rose-700 hover:bg-rose-600 disabled:opacity-50 px-2 py-1"
            disabled={!connected}
            onClick={async () => {
              if (!confirm('This wipes ALL stored prefs on the glasses (factory reset, opcode 0xBF). Continue?')) return;
              await guard('factory reset', () => edgeDevice.factoryReset())();
            }}
            title="Wipe all stored prefs (0xBF)"
          >
            Factory reset
          </button>
        </div>
      </Section>
    </div>
  );
}

function Section({
  label, hint, children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-slate-300 mb-1">{label}</div>
      {children}
      {hint && <div className="text-[10px] text-slate-500 mt-1">{hint}</div>}
    </div>
  );
}

function btnClass(active: boolean): string {
  return (
    'rounded px-2 py-1 text-[11px] disabled:opacity-50 ' +
    (active ? 'bg-indigo-600 hover:bg-indigo-500 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-200')
  );
}

function Slider({
  label, unit, min, max, step, value, onChange, onCommit, disabled, help,
}: {
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  onCommit: (v: number) => void;
  disabled: boolean;
  help?: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-0.5">
        <span className="text-slate-300">{label}</span>
        <span className="text-slate-200 tabular-nums text-[11px]">
          {value} <span className="text-slate-500">{unit}</span>
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        onMouseUp={(e) => onCommit(Number((e.target as HTMLInputElement).value))}
        onTouchEnd={(e) => onCommit(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => onCommit(Number((e.target as HTMLInputElement).value))}
        className="w-full accent-indigo-500 disabled:opacity-50"
      />
      {help && <div className="text-[10px] text-slate-500 mt-0.5">{help}</div>}
    </div>
  );
}

function Toggle({
  checked, disabled, onChange, label, help,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
  label: string;
  help?: string;
}) {
  return (
    <label className="flex items-start gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-indigo-500"
      />
      <div className="flex-1 min-w-0">
        <div className="text-slate-200 text-[11px]">{label}</div>
        {help && <div className="text-[10px] text-slate-500">{help}</div>}
      </div>
    </label>
  );
}
