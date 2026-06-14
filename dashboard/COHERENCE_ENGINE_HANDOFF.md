# Coherence Engine (dashboard) — Handoff

Last updated: 2026-06-14. Read this before continuing the app-side Coherence Engine work.

## TL;DR

The Swift `NarbisCoherenceEngine` was ported into this React/TS dashboard. It runs **app-side**
(main thread), computes coherence/resonance from the live signal, and **drives the glasses** by
streaming a 0–100 lens duty over BLE opcode `0xA5`. There's a 3-mode selector
(**Firmware / Mode A (Follow) / Mode B (Resonance)**), all tunables are exposed per-mode with
presets, plus an ACC breathing-wave graph and a breathing chime. It's deployed live.

**The #1 unfinished task: make the 4 "Standard programs" run app-side under Mode A/B** (the engine
renders the selected program's lens duty and streams `0xA5`, instead of the firmware running the
program). Details in §3.

## 1. How to build / test / deploy

```
cd dashboard
npm run typecheck     # tsc --noEmit (also the lint script)
npm run test          # vitest — engine math tests in src/engine/__tests__/engine.test.ts
npm run build         # tsc + vite build
npm run dev           # local dev server
```

**Deploy:** commit + push to `main`. `.github/workflows/dashboard-deploy.yml` runs `npm ci && npm
run build`, renames `dist/index.html → app.html`, and publishes to GitHub Pages (~2–3 min). Live at
`https://narbiscorp.github.io/edge-earclip/app.html`. Always `npm run typecheck` + `npm run test`
before pushing. End commit messages with the Co-Authored-By trailer.

## 2. Architecture map

**Engine (pure TS, framework-agnostic, single-threaded — no locks):** `src/engine/`
- `tunables.ts` — `CoherenceTunables` + `DEFAULT_TUNABLES` (app-side floats; NOT firmware config).
- `coherenceEngine.ts` — orchestrator singleton `coherenceEngine` (an `EventTarget`). `start()`,
  `stop()`, `setMode()`, `setTunables()`, `onH10RR()`, `onRR()`, `onAccPacket()`. Runs a 1 Hz
  analysis tick, a breath-boundary scheduler, and a **~12 Hz lens-duty output tick** that calls the
  `onDuty(duty)` callback. Emits `'status'` (`EngineStatus`).
- `ibiIngest.ts`, `lombScargleCore.ts`, `followPacer.ts`, `fastAmplitude.ts`,
  `respirationFromAcc.ts`, `resonanceController.ts` (Mode B state machine), `lensPrograms.ts`,
  `dsp.ts`. Faithful ports of the Swift classes (see
  `C:\CODE\EDGE Coherence Engine\updates\NarbisCoherenceEngine.swift`).

**Store wiring:** `src/state/store.ts`
- `engineMode: 'firmware' | 'modeA' | 'modeB'` (persisted), `coherenceTunables`, `engineStatus`.
- `setEngineMode` (the lifecycle action) and `startCoherenceEngine`/`stopCoherenceEngine`/
  `initCoherenceEngine` (engine resumes on app load).
- **Critical:** the `'status'` listener **mirrors engine output into `lastEdgeCoherence` +
  `edgeCoherenceBuffers.live` + the session** so all the firmware-coupled UI (coherence chart, IBI
  tachogram resp/pacer, breath cue, lens-tint mirror) reflects the engine when it's running (the
  firmware `0xF2` frame stops arriving while the engine drives).
- `onDuty` is wired to `edgeDevice.streamLensDuty(d)`.
- Beats feed the engine from the `polarH10`/`narbisDevice` `'beatReceived'` handlers; ACC from
  `polarH10` `'accReceived'`.

**Lens output (drive the glasses):** `src/ble/edgeDevice.ts` → `streamLensDuty(0..100)` sends
`STATIC_DUTY (0xA5)` (write-without-response preferred, coalesced, serialized through `writeQueue`).

**BLE input:** `src/ble/polarH10.ts` (HR + PMD accelerometer), `src/ble/narbisDevice.ts` (earclip).

**UI:** `src/components/engine/CoherenceEnginePanel.tsx` (Expert) + `CoherencePresetBar.tsx`;
`src/components/BasicMode.tsx` has the `EngineModeStrip`, `BreathCue`, `ChimeControls`, `AccChart`,
and `ProgramStrip`. Shared mode copy/status: `src/components/engine/modeInfo.ts`.

## 3. UNFINISHED: app-side training programs (the main task)

**Goal.** Today the firmware has 4 PPG programs selected via opcode `0xB7`:
1. **Heartbeat** — lens pulses on each beat.
2. **Coh Breathe** (Breathing Guide) — 6 br/min breathing wave modulated by coherence.
3. **Coh Lens** (Coherence Lens) — direct coherence → opacity.
4. **Breathe + Strobe** — breathe wave + strobe.

In **Firmware** mode these run on the glasses (send `0xB7`). In **Mode A/B** the engine should run
the SAME program logic **app-side** and stream the resulting `0xA5` duty — NOT send `0xB7`. The user
wants all 4 programs selectable under any of the 3 modes; in Mode A/B the engine renders them.

**Current state to change:**
- `coherenceEngine.ts` only renders a fixed breathe cue (`lensStyle: 'breathe'`, default) in
  `lensTick()`. There's a vestigial `lensStyle: 'breathe' | 'program2'` option — generalize it.
- `setEngineMode` clears `activeProgram` on entering Mode A/B (`store.ts`), and `ProgramStrip` is
  disabled when the engine is active (`BasicMode.tsx`). Both need to change.

**What to build:**
1. **Engine:** add `program: 1|2|3|4` + `setProgram(p)`. In `lensTick()`, render the selected
   program's duty. Track `lastBeatMs` (set in `onH10RR`/`onRR`) for Heartbeat. The building blocks
   already exist in `src/engine/lensPrograms.ts`: `heartbeatDuty()`, `breatheFraction()`,
   `breatheDuty()`, `Program2Lens` (EWMA + gamma difficulty). Add `difficulty` (0–3) handling.
2. **Store:** change `setActiveProgram(p)` — in `firmware` mode keep current behavior (send `0xB7`);
   in Mode A/B call `coherenceEngine.setProgram(p)` and do **not** send `0xB7`. Don't clear
   `activeProgram` when entering Mode A/B (default it to `2` if null) and pass it to
   `coherenceEngine.start({ program })`. On returning to `firmware`, re-send the current program via
   `0xB7`.
3. **UI:** enable `ProgramStrip` in all modes (remove the `engineActive` disable + hint in
   `BasicMode.tsx`); wire the Basic difficulty selector to `coherenceEngine.setDifficulty` when the
   engine is active.

**Authoritative duty formulas — use these two references (don't invent):**
- `src/state/useLensOpacity.ts` — the team's existing JS mirror of all 4 programs (good structure,
  but a SIMPLIFIED approximation: it uses linear coherence scaling, not the firmware gamma curve).
- Firmware `C:\NARBIS APP\Oct_4_25\Clone\edge-firmware\v4\Code-Glasses\main\main.c` — the ground
  truth. `grep` for `LED_MODE_`, `effective_duty`, `lens_clear_pct`, `gamma`, `breathe_frac`,
  `strobe`. Confirmed so far:
  - **Coherence Lens:** `effective_duty = brightness × (100 − coh) / 100`.
  - **Gamma difficulty** (applies to the coherence→clear mapping): `lens_clear_pct =
    (coh/100)^gamma × 100`, then `effective_duty = brightness × (100 − lens_clear_pct)/100`. Gamma
    table by difficulty Easy/Med/Hard/Expert ≈ `[1.0, 1.5, 2.0, 3.0]` (already in `DEFAULT_TUNABLES`).
  - **Breathe:** 40/60 inhale/exhale wave at the pacer rate; firmware modulates its amplitude by
    coherence. (`breatheFraction` + `breatheDuty` already implement this; `Program2Lens` adds the
    gamma/EWMA variant — decide which matches Coh Breathe by reading main.c.)
  - **Heartbeat:** ~150 ms cosine pulse on each accepted beat, peak ~80% duty (`heartbeatDuty`).
  - **Breathe+Strobe:** breathe wave × strobe. **Caveat:** the firmware strobe is ~10 Hz hardware-
    side; you **cannot** stream a 10 Hz strobe over `0xA5` (BLE can't sustain ~20 writes/sec, and
    the engine doc says per-tick strobe >~10 Hz is impractical). Options: (a) render breathe +
    a BLE-feasible low-rate (~3 Hz) strobe square, matching `useLensOpacity`'s Program 4; or (b)
    keep the strobe glasses-side (put the glasses in strobe mode and let them strobe locally while
    you modulate brightness). Recommend (a) for v1; note the limitation in the UI.

**Watch out:** the breath phase must stay **continuous** — derive it from the engine's own
`cycleStartMs` (in `coherenceEngine.lensTick`), NOT `Date.now() % cycleMs` (see §5). The engine
already tracks `cycleStartMs`/`cycleMs`, so Programs 2/4 should read from those.

## 4. Other unfinished / needs on-device validation

- **Polar ACC (Mode B respiration) — just fixed, needs hardware confirmation.** The H10 rejected
  the start with `status 5` (INVALID PARAMETER) because the start command had a malformed 1-byte
  CHANNELS TLV. `polarH10.ts` now **queries supported settings first** (`GET MEASUREMENT SETTINGS`
  `0x01,0x02`), starts with a valid combo (prefer 50 Hz / ±8 g / 16-bit, no CHANNELS TLV), and
  parses the control-point response. **Verify on-device:** Expert → BLE log → filter `polar`. Expect
  `ACC: H10 ACC supports rates [...]`, `ACC: ACC started: …`, `ACC: ACC streaming — N samples/frame`.
  Then confirm the **Breathing-wave graph** fills and **Mode B verifies breaths** (status leaves the
  "couldn't confirm" loop and moves past 6 br/min). If it still rejects, the log now prints the
  device's supported settings — pick a guaranteed combo from them. ACC frame decode is delta-framed
  and **byte-aligned per group** (Polar SDK: `offset += ceil(deltaSize·channels·sampleCount/8)`),
  see `parseAccFrame`. PMD setting values are **16-bit LE** — never send 1-byte TLVs.
- **`0xA5` duty stream rate.** `coherenceEngine` streams at `LENS_TICK_MS = 83` (~12 Hz). Validate
  the glasses don't saturate; the CTRL char should expose write-without-response (it falls back to
  with-response). Tune the rate if the BLE log shows write errors.
- **Mode B convergence on real HRV** — needs a still, seated session with a Polar H10.
- **Mode B verification** now passes a dwell on a **majority** of verified estimate-breaths (not
  all); tune `respConfidenceMin` / `respVerifyToleranceBPM` against real ACC if it's too strict/loose.

## 5. Key facts & gotchas

- `engineMode` is **persisted**; `initCoherenceEngine()` (called from `App.tsx`) resumes the engine
  on load so the UI isn't a selected-but-off engine.
- The store **mirrors** engine output into the firmware-coherence channels (§2) — keep that intact
  when adding programs, or the charts/cues go stale.
- **Breath phase must be continuous.** Deriving it from `Date.now() % cycleMs` jumps when the rate
  changes and desyncs the chime/cue — `useBreathPhase` and `BreathCue` accumulate phase instead.
- **Coherence tunables ≠ firmware config.** Firmware config (`NarbisRuntimeConfig`) is a flat
  all-integer wire struct with its own preset system. Coherence tunables are app-side floats with a
  **separate** schema (`components/engine/coherenceFieldSchema.ts`), validation, and preset store.
- Web Bluetooth is **main-thread only** — engine output/BLE can't run in a worker.
- Score is shown **x/100** (the raw 0–100 coherence), not x.x/10.
- H10 beats are de-spiked (missed-beat-double outlier gate) in `store.ts` before the buffer /
  forwarding; the engine still gets RAW beats (it has its own gate + needs artifact awareness).

## 6. Suggested order for the programs task

1. Engine: add `program` + `difficulty` + `setProgram`/`setDifficulty`; render all 4 in `lensTick`
   off `cycleStartMs`/`cycleMs`; track `lastBeatMs`. Reuse `lensPrograms.ts`.
2. Confirm each program's exact duty against `main.c` (esp. gamma + which lens Coh Breathe uses).
3. Store: rework `setActiveProgram` (firmware → `0xB7`; Mode A/B → `engine.setProgram`), keep
   `activeProgram` across mode switches, pass `program` to `engine.start`.
4. UI: enable `ProgramStrip` in all modes; wire difficulty to the engine in Mode A/B.
5. Decide Breathe+Strobe strategy (§3 caveat).
6. `npm run typecheck && npm run test && npm run build`, then deploy + validate on hardware.

## 7. References

- Engine source of truth: `C:\CODE\EDGE Coherence Engine\updates\NarbisCoherenceEngine.swift` and
  the doc `C:\CODE\EDGE Coherence Engine\Narbis-Edge-Coherence-Engine.md` (§8 tunables table, BLE
  opcodes, the program/lens math).
- Firmware programs: `C:\NARBIS APP\Oct_4_25\Clone\edge-firmware\v4\Code-Glasses\main\main.c`.
- Existing JS mirror of the programs: `src/state/useLensOpacity.ts`.
