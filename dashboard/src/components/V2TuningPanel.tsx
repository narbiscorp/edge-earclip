/*
 * V2TuningPanel.tsx — Expert-sidebar tuning for the V2.1 (AFE4404) earclip.
 *
 * Renders nothing unless a V2 board is connected (auto-detected at connect),
 * so the v1 earclip's existing ConfigPanel keeps the sidebar to itself.
 *
 * Three collapsible groups, ordered the way you actually tune a PPG chain:
 *   1. Signal   — what the sensor does: rate, LED currents, TIA gain, AGC.
 *   2. Filtering— what the app does to make the wave readable (host-side).
 *   3. Beats    — what the firmware does to turn the wave into IBIs.
 *
 * Device writes are debounced: dragging a slider must not put one CONTROL
 * write per animation frame on a 100 ms BLE connection interval.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useDashboardStore } from '../state/store';
import { narbisDevice } from '../ble/narbisDevice';
import {
  KNOB, TIA_RF_OHMS, LED_IR_MAX_MA, LED_RED_MAX_MA,
  AGC_ST_ACQUIRE, AGC_ST_LOCKED, AGC_STATE_NAME, AGC_REASON_NAME, PROTO_VER_AGC_STATE,
} from '../ble/v2/protocol';
import { PPG_FILTER_DEFAULTS } from '../ble/v2/ppgFilter';

const WRITE_DEBOUNCE_MS = 180;

function Section({
  title, hint, defaultOpen = false, children,
}: {
  title: string; hint?: string; defaultOpen?: boolean; children: React.ReactNode;
}) {
  return (
    <details open={defaultOpen} className="rounded border border-slate-800 bg-slate-900/40">
      <summary className="cursor-pointer select-none px-2 py-1.5 text-[11px] font-medium text-slate-200 hover:bg-slate-800/60">
        {title}
        {hint ? <span className="ml-2 font-normal text-[10px] text-slate-500">{hint}</span> : null}
      </summary>
      <div className="flex flex-col gap-2 px-2 pb-2 pt-1">{children}</div>
    </details>
  );
}

function Slider({
  label, value, min, max, step = 1, unit, onChange, title,
}: {
  label: string; value: number; min: number; max: number; step?: number;
  unit?: string; onChange: (v: number) => void; title?: string;
}) {
  return (
    <label className="block" title={title}>
      <div className="flex items-baseline justify-between text-[10px] text-slate-400">
        <span>{label}</span>
        <span className="font-mono text-slate-200">
          {value}{unit ? ` ${unit}` : ''}
        </span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-indigo-500"
      />
    </label>
  );
}

function Row({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <label className="flex items-center justify-between gap-2 text-[10px] text-slate-400" title={title}>
      <span>{label}</span>
      {children}
    </label>
  );
}

/** One link-health cell: value turns amber (or red for `bad`) when non-zero. */
function Health({
  label, value, warn, bad = false, title,
}: { label: string; value: string | number; warn: boolean; bad?: boolean; title: string }) {
  const tone = !warn ? 'text-slate-200' : bad ? 'text-red-400' : 'text-amber-400';
  return (
    <span title={title}>
      {label} <span className={tone}>{value}</span>
    </span>
  );
}

export default function V2TuningPanel() {
  const isV2 = useDashboardStore((s) => s.earclipProtocol === 'v2');
  const st = useDashboardStore((s) => s.v2Status);
  const link = useDashboardStore((s) => s.v2LinkStats);
  const fw = useDashboardStore((s) => s.earclipFirmware);
  const protoVer = useDashboardStore((s) => s.earclipProtoVer);
  const agcReason = useDashboardStore((s) => s.v2AgcReason);
  const agcKnown = protoVer !== null && protoVer >= PROTO_VER_AGC_STATE;
  /* Gain-lock knobs: firmware defaults until read from the device. */
  const [lock, setLock] = useState({
    mode: 1, beats: 6, stableS: 8, bandPct: 38, satS: 3, driftS: 15, minS: 30,
  });
  const [reacqBusy, setReacqBusy] = useState(false);
  const lockSeeded = useRef(false);
  const filter = useDashboardStore((s) => s.ppgFilter);
  const setFilter = useDashboardStore((s) => s.setPpgFilter);

  /* Local mirrors so sliders stay responsive while the debounced device
   * write is in flight. Seeded from STATUS once it arrives. */
  const [irMa, setIrMa] = useState(12);
  const [redMa, setRedMa] = useState(8);
  const [rfCode, setRfCode] = useState(2);
  const [agcFrozen, setAgcFrozen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seeded = useRef(false);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    if (!st || seeded.current) return;
    seeded.current = true;
    setIrMa(st.ledIrMa); setRedMa(st.ledRedMa); setRfCode(st.tiaGainCode);
  }, [st]);
  useEffect(() => { if (!isV2) seeded.current = false; }, [isV2]);

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await fn(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }, []);

  /** Coalesce rapid slider motion into one device write per key. */
  const debounced = useCallback((key: string, fn: () => Promise<void>) => {
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(() => void run(fn), WRITE_DEBOUNCE_MS);
  }, [run]);

  /* Manual LED/TIA writes are rejected by firmware unless AGC is frozen —
   * freeze on first manual touch rather than making the user find a toggle
   * and then wonder why their slider "did nothing". */
  const ensureFrozen = useCallback(async () => {
    if (agcFrozen) return;
    await narbisDevice.v2SetAgcFrozen(true);
    setAgcFrozen(true);
  }, [agcFrozen]);

  /* Read what the device is actually using, once per connection. */
  useEffect(() => {
    if (!isV2 || !agcKnown || lockSeeded.current) return;
    lockSeeded.current = true;
    void (async () => {
      try {
        const g = (id: number) => narbisDevice.v2KnobGet(id);
        const mode = await g(KNOB.AGC_MODE);
        const beats = await g(KNOB.AGC_LOCK_BEATS);
        const stable = await g(KNOB.AGC_LOCK_STABLE_MS);
        const band = await g(KNOB.AGC_LOCK_BAND_PCT);
        const sat = await g(KNOB.AGC_REACQ_SAT_MS);
        const drift = await g(KNOB.AGC_REACQ_DRIFT_MS);
        const min = await g(KNOB.AGC_REACQ_MIN_S);
        setLock({
          mode, beats, stableS: stable / 1000, bandPct: band,
          satS: sat / 1000, driftS: drift / 1000, minS: min,
        });
      } catch {
        /* keep the defaults shown */
      }
    })();
  }, [isV2, agcKnown]);
  useEffect(() => { if (!isV2) lockSeeded.current = false; }, [isV2]);

  if (!isV2) return null;

  const knob = (id: number, v: number) => debounced(`k${id}`, () => narbisDevice.v2KnobSet(id, v));

  return (
    <div className="rounded border border-slate-800 bg-slate-900/50 p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <div className="text-[12px] font-medium text-slate-200">
            Earclip V2.1 tuning
            <span className="ml-2 text-[9px] font-mono text-emerald-400 align-middle">AFE4404</span>
          </div>
          {fw ? (
            <div className="truncate text-[9px] font-mono text-slate-500" title={`Firmware revision reported by the earclip (Device Information): ${fw}`}>
              fw {fw}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => narbisDevice.v2KnobSave())}
          className="text-[10px] rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-50 px-2 py-0.5 text-slate-300"
          title="Persist the device-side knobs to NVS. Without this they revert on reboot."
        >
          save to device
        </button>
      </div>

      {/* Live readout — what the device is ACTUALLY doing, which is not
          always what the sliders say (AGC moves currents on its own). */}
      {st ? (
        <div className="grid grid-cols-3 gap-1 text-[9px] font-mono text-slate-400">
          <span title="LED currents actually applied by the device">
            IR <span className="text-slate-200">{st.ledIrMa}</span> ·
            RED <span className="text-slate-200">{st.ledRedMa}</span> mA
          </span>
          <span title="Transimpedance gain currently selected">
            RF <span className="text-slate-200">{(TIA_RF_OHMS[st.tiaGainCode] / 1000) || '?'}</span>k
          </span>
          <span title="Heart rate from the device's own beat detector">
            HR <span className="text-slate-200">{st.hrBpm || '—'}</span>
          </span>
          <span title="Percentage of recent time the artifact gate was active">
            gate <span className="text-slate-200">{(st.gateDutyX100 / 100).toFixed(0)}</span>%
          </span>
          {/* Device uptime, not the since-boot drop counter: that one also
              counts drops from earlier clients (see "dev drops" below for
              this connection). A reset uptime means the earclip rebooted. */}
          <span title="Earclip uptime since boot — if this resets, the earclip rebooted">
            up <span className="text-slate-200">
              {st.uptimeS >= 3600
                ? `${Math.floor(st.uptimeS / 3600)}h${String(Math.floor((st.uptimeS % 3600) / 60)).padStart(2, '0')}`
                : `${Math.floor(st.uptimeS / 60)}m${String(st.uptimeS % 60).padStart(2, '0')}`}
            </span>
          </span>
          <span title="Battery">
            {(st.battMv / 1000).toFixed(2)}V <span className="text-slate-200">{st.battPct}%</span>
          </span>
        </div>
      ) : (
        <div className="text-[10px] text-slate-500">waiting for status…</div>
      )}

      {/* Link health since connect — is the data complete and trustworthy? */}
      {link ? (
        <div className="flex flex-col gap-1 rounded border border-slate-800 px-1.5 py-1">
          <div className="text-[9px] uppercase tracking-wide text-slate-500">link health since connect</div>
          <div className="grid grid-cols-3 gap-1 text-[9px] font-mono text-slate-400">
            <Health
              label="lost" value={link.ppgLostBatches} warn={link.ppgLostBatches > 0}
              title={`PPG batches missing between sequence numbers (BLE or device drops). ${link.ppgBatches} received, ${link.ppgSeqRestarts} stream restart(s).`}
            />
            <Health
              label="clipped" value={link.clippedBatches} warn={link.clippedBatches > 0}
              title="Batches the device flagged CLIPPED — the ADC hit full scale (too much light or gain). Lower LED current or TIA gain."
            />
            <Health
              label="rate"
              value={link.measuredSps !== null ? link.measuredSps.toFixed(1) : '—'}
              warn={link.measuredSps !== null && link.nominalSps !== null &&
                Math.abs(link.measuredSps - link.nominalSps) > link.nominalSps * 0.01}
              title={`Sample rate implied by the device's own clock (nominal ${link.nominalSps ?? '?'} sps).`}
            />
            <Health
              label="dev drops"
              value={link.deviceDrops !== null && link.deviceDropsStart !== null
                ? link.deviceDrops - link.deviceDropsStart : '—'}
              warn={link.deviceDrops !== null && link.deviceDropsStart !== null &&
                link.deviceDrops > link.deviceDropsStart}
              title="Notifications the device dropped from its own send queues since connect (any stream, including ones this app does not subscribe to)."
            />
            <Health
              label="decode err" value={link.parseErrors} warn={link.parseErrors > 0} bad
              title={link.lastParseError
                ? `Frames this app could not decode — a dashboard/firmware layout mismatch. Last: ${link.lastParseError}`
                : 'Frames this app could not decode (layout mismatch). Should stay 0.'}
            />
            <Health
              label="i2c err"
              value={link.i2cErrors !== null && link.i2cErrorsStart !== null
                ? link.i2cErrors - link.i2cErrorsStart : '—'}
              warn={link.i2cErrors !== null && link.i2cErrorsStart !== null &&
                link.i2cErrors > link.i2cErrorsStart}
              title="Device I²C errors since connect (sensor bus)."
            />
          </div>
          <div className="text-[9px] leading-snug text-slate-500">
            Raw capture: press <span className="text-slate-300">● Record</span> — the zip's
            <span className="font-mono text-slate-300"> v2/</span> folder holds every sample
            (ir, red, amb, seq, flags), every beat, status frame and device event, plus a
            README and <span className="font-mono text-slate-300">ble_log.txt</span>.
          </div>
        </div>
      ) : null}

      {err ? (
        <div className="rounded border border-red-700/40 bg-red-900/20 px-2 py-1 text-[10px] text-red-300">
          {err}
        </div>
      ) : null}

      {/* ---------------- 1. Signal ---------------- */}
      <Section title="Signal" hint="LED · gain · AGC" defaultOpen>
        <Row label="Sample rate" title="Also sets LED optical duty: the AFE lights each die only during its sampling window, so higher rates are brighter as well as faster.">
          <select
            value={st?.ppgRateCode ?? 1}
            onChange={(e) => void run(async () => {
              const sps = [50, 100, 200, 250, 500][Number(e.target.value)];
              await narbisDevice.v2SetRate(sps);
            })}
            className="bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-200"
          >
            {[50, 100, 200, 250, 500].map((sps, code) => (
              <option key={sps} value={code}>{sps} sps</option>
            ))}
          </select>
        </Row>

        <Row label="AGC" title="The device's automatic gain control moves LED currents to hold the DC level in band. Freeze it to set currents by hand.">
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(async () => {
              await narbisDevice.v2SetAgcFrozen(!agcFrozen);
              setAgcFrozen(!agcFrozen);
            })}
            className={`rounded px-2 py-0.5 text-[10px] border ${
              agcFrozen
                ? 'border-amber-600/60 bg-amber-900/30 text-amber-300'
                : 'border-slate-700 bg-slate-800 text-slate-300'
            }`}
          >
            {agcFrozen ? 'frozen (manual)' : 'running (auto)'}
          </button>
        </Row>

        <Slider
          label="IR LED" value={irMa} min={0} max={LED_IR_MAX_MA} unit="mA"
          title="IR drive current. This is the default channel for beat detection."
          onChange={(v) => {
            setIrMa(v);
            debounced('ir', async () => { await ensureFrozen(); await narbisDevice.v2SetManual({ irMa: v }); });
          }}
        />
        <Slider
          label="Red LED" value={redMa} min={0} max={LED_RED_MAX_MA} unit="mA"
          title="Red drive current. Needed for SpO2-style ratio work; not required for beats."
          onChange={(v) => {
            setRedMa(v);
            debounced('red', async () => { await ensureFrozen(); await narbisDevice.v2SetManual({ redMa: v }); });
          }}
        />
        <Row label="TIA gain" title="Transimpedance feedback resistor — converts photocurrent to voltage. Raise for a weak signal; lower if the trace clips.">
          <select
            value={rfCode}
            onChange={(e) => {
              const code = Number(e.target.value);
              setRfCode(code);
              void run(async () => { await ensureFrozen(); await narbisDevice.v2SetManual({ rfCode: code }); });
            }}
            className="bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-200"
          >
            {Object.entries(TIA_RF_OHMS).map(([code, ohms]) => (
              <option key={code} value={code}>
                {ohms >= 1e6 ? `${ohms / 1e6}MΩ` : `${ohms / 1e3}kΩ`}
              </option>
            ))}
          </select>
        </Row>
      </Section>

      {/* ---------------- Gain lock (firmware AGC policy) ---------------- */}
      <Section title="Gain lock (AGC)" hint="adjust at first, then hold still" defaultOpen>
        {agcKnown && st ? (
          <div className="flex items-center justify-between text-[10px]">
            <span
              className={`rounded px-1.5 py-0.5 font-mono ${
                st.agcState === AGC_ST_LOCKED ? 'bg-emerald-900/50 text-emerald-300'
                  : st.agcState === AGC_ST_ACQUIRE ? 'bg-amber-900/40 text-amber-300'
                    : 'bg-slate-800 text-slate-400'}`}
              title="ACQUIRE: the AGC is adjusting LED current / gain. LOCKED: no more adjustments, so the raw trace has no gain steps."
            >
              {AGC_STATE_NAME[st.agcState] ?? st.agcState}
            </span>
            <span className="text-slate-500">
              {agcReason !== null ? (AGC_REASON_NAME[agcReason] ?? `reason ${agcReason}`) : ''}
              {st.agcReacqCount ? ` · re-acquired ${st.agcReacqCount}×` : ''}
            </span>
            <button
              type="button"
              disabled={busy || reacqBusy}
              onClick={() => void run(async () => {
                setReacqBusy(true);
                try {
                  await narbisDevice.v2AgcReacquire();
                  setAgcFrozen(false);
                } finally {
                  setReacqBusy(false);
                }
              })}
              className="rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-50 px-2 py-0.5 text-slate-300"
              title="Adjust the gain again now (e.g. after re-seating the clip), then lock"
            >
              {reacqBusy ? 're-acquiring…' : 're-acquire now'}
            </button>
          </div>
        ) : (
          <div className="text-[9px] leading-snug text-amber-400/90">
            This firmware predates the gain lock (protocol{' '}
            {protoVer !== null ? `${protoVer >> 8}.${protoVer & 0xff}` : '?'}): the AGC may step the
            LEDs every couple of seconds. Update to v0.3.0-26 or later.
          </div>
        )}
        <div className="text-[9px] leading-snug text-slate-500">
          Every gain adjustment is a step in the raw signal. In lock mode the earclip adjusts only
          until it finds clean beats (or a steady level), then holds; it re-adjusts only after
          sustained clipping, or a level that drifted away with no beats left.
        </div>
        <Row label="Mode" title="Lock: adjust at first, then hold. Continuous: the old behaviour, adjusts whenever the level leaves the band.">
          <select
            value={lock.mode}
            disabled={!agcKnown}
            onChange={(e) => {
              const v = Number(e.target.value);
              setLock((l) => ({ ...l, mode: v }));
              knob(KNOB.AGC_MODE, v);
            }}
            className="bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-200 disabled:opacity-40"
          >
            <option value={1}>lock after acquire</option>
            <option value={0}>continuous (legacy)</option>
          </select>
        </Row>
        <Slider
          label="Lock after clean beats" value={lock.beats} min={1} max={30} unit="beats"
          title="Consecutive clean beats (not gated, not during a gain change, not the first after a gap) that lock the gain."
          onChange={(v) => { setLock((l) => ({ ...l, beats: v })); knob(KNOB.AGC_LOCK_BEATS, v); }}
        />
        <Slider
          label="…or a steady level for" value={lock.stableS} min={1} max={60} unit="s"
          title="Also lock when the level has sat in the target band needing no change this long — covers a pulse too weak for the beat detector."
          onChange={(v) => { setLock((l) => ({ ...l, stableS: v })); knob(KNOB.AGC_LOCK_STABLE_MS, v * 1000); }}
        />
        <Slider
          label="Hold while within" value={lock.bandPct} min={10} max={50} unit="% FS of target"
          title="While locked, a level inside target ± this is left alone. Wider = fewer re-adjustments."
          onChange={(v) => { setLock((l) => ({ ...l, bandPct: v })); knob(KNOB.AGC_LOCK_BAND_PCT, v); }}
        />
        <Slider
          label="Re-adjust after clipping for" value={lock.satS} min={0.5} max={30} step={0.5} unit="s"
          title="Clipped samples are lost data: re-adjust if the ADC stays clipped this long."
          onChange={(v) => { setLock((l) => ({ ...l, satS: v })); knob(KNOB.AGC_REACQ_SAT_MS, Math.round(v * 1000)); }}
        />
        <Slider
          label="Re-adjust after drift with no beats for" value={lock.driftS} min={1} max={60} unit="s"
          title="If the level leaves the hold band AND no clean beats arrive for this long, re-adjust. While beats keep coming it never does."
          onChange={(v) => { setLock((l) => ({ ...l, driftS: v })); knob(KNOB.AGC_REACQ_DRIFT_MS, v * 1000); }}
        />
        <Slider
          label="Never re-adjust sooner than" value={lock.minS} min={5} max={600} step={5} unit="s after a lock"
          title="Hard limit on how often the gain may change once locked."
          onChange={(v) => { setLock((l) => ({ ...l, minS: v })); knob(KNOB.AGC_REACQ_MIN_S, v); }}
        />
      </Section>

      {/* ---------------- 2. Filtering (host-side) ---------------- */}
      <Section title="Filtering" hint="app-side · shapes the wave">
        <div className="text-[9px] leading-snug text-slate-500">
          The device streams raw counts: a large DC pedestal with a ~1 % pulse on
          top. These run in the app and produce the Filtered chart.
        </div>
        <Slider
          label="DC removal (high-pass)" value={filter.hpFc} min={0.1} max={2} step={0.05} unit="Hz"
          title="Removes the baseline. Too low leaves wander; too high starts eating the pulse shape."
          onChange={(v) => setFilter({ hpFc: v })}
        />
        <Slider
          label="Band low" value={filter.bpLo} min={0.2} max={2} step={0.05} unit="Hz"
          title="Lowest heart rate to pass. 0.5 Hz = 30 bpm."
          onChange={(v) => setFilter({ bpLo: v })}
        />
        <Slider
          label="Band high" value={filter.bpHi} min={2} max={15} step={0.5} unit="Hz"
          title="Highest frequency kept. 8 Hz keeps the dicrotic notch and rejects the rest."
          onChange={(v) => setFilter({ bpHi: v })}
        />
        <Row label="Mains notch" title="Only useful when the sample rate is well above twice the mains frequency.">
          <span className="flex items-center gap-1">
            <input
              type="checkbox" checked={filter.notchEn}
              onChange={(e) => setFilter({ notchEn: e.target.checked })}
              className="accent-indigo-500"
            />
            <select
              value={filter.notchHz}
              onChange={(e) => setFilter({ notchHz: Number(e.target.value) })}
              disabled={!filter.notchEn}
              className="bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-200 disabled:opacity-40"
            >
              <option value={50}>50 Hz</option>
              <option value={60}>60 Hz</option>
            </select>
          </span>
        </Row>
        <Row label="Invert (peaks up)" title="Transmissive PPG dips when blood absorbs light, so the trace is inverted to look like a normal plethysmogram.">
          <input
            type="checkbox" checked={filter.invert}
            onChange={(e) => setFilter({ invert: e.target.checked })}
            className="accent-indigo-500"
          />
        </Row>
        <button
          type="button"
          onClick={() => setFilter({ ...PPG_FILTER_DEFAULTS, sampleRate: filter.sampleRate })}
          className="self-start text-[10px] rounded bg-slate-800 hover:bg-slate-700 px-2 py-0.5 text-slate-300"
        >
          reset filter defaults
        </button>
      </Section>

      {/* ---------------- 3. Beat detection (device-side) ---------------- */}
      <Section title="Beat detection" hint="on-device → IBI stream">
        <div className="text-[9px] leading-snug text-slate-500">
          The firmware detects beats and streams intervals; these knobs tune that
          detector. Changes are live — press “save to device” to keep them.
        </div>
        <Row label="Channel" title="Which LED the beat detector runs on. IR is the default and usually the stronger transmissive signal.">
          <select
            defaultValue={0}
            onChange={(e) => knob(KNOB.IBI_CHANNEL, Number(e.target.value))}
            className="bg-slate-800 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-200"
          >
            <option value={0}>IR</option>
            <option value={1}>Red</option>
          </select>
        </Row>
        <Slider
          label="Threshold fraction" value={50} min={10} max={90} unit="%"
          title="Peak must exceed this fraction of the running peak amplitude. Lower catches weak beats but risks false ones."
          onChange={(v) => knob(KNOB.THR_FRAC_X100, v)}
        />
        <Slider
          label="Refractory" value={280} min={150} max={500} step={10} unit="ms"
          title="Minimum spacing between accepted beats — blocks double-counting the dicrotic notch. 280 ms ≈ 214 bpm ceiling."
          onChange={(v) => knob(KNOB.REFRACT_MS, v)}
        />
        <Slider
          label="Slope window" value={80} min={20} max={200} step={5} unit="ms"
          title="Slope-sum window for the systolic upstroke. Widen for slow/soft pulses."
          onChange={(v) => knob(KNOB.SSF_WIN_MS, v)}
        />
        <Row label="Artifact gate" title="Suppresses beats during motion or AGC settling. Leave on unless debugging.">
          <input
            type="checkbox" defaultChecked
            onChange={(e) => knob(KNOB.GATE_EN, e.target.checked ? 1 : 0)}
            className="accent-indigo-500"
          />
        </Row>
      </Section>
    </div>
  );
}
