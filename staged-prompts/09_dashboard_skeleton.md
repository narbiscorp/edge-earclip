# Stage 09 — Dashboard project scaffolding

## Task

Bootstrap the Vite + React + TypeScript dashboard under `dashboard/`. Skeleton only — no real functionality.

## Read first

- `CLAUDE.md`
- `protocol/narbis_protocol.ts`
- `protocol/uuids.ts`

## What to build

1. **`dashboard/package.json`** with scripts: dev, build, preview, typecheck, lint
   - Dependencies: react, react-dom, plotly.js, react-plotly.js, zustand, tailwindcss, typescript, vite, @vitejs/plugin-react

2. Standard configs: `vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `tailwind.config.js`, `postcss.config.js`

3. **`dashboard/index.html`** with title "Narbis Earclip Dashboard"

4. **Source structure**:
   - `dashboard/src/main.tsx` — React root
   - `dashboard/src/App.tsx` — top-level layout (header, main grid, sidebar, status bar)
   - `dashboard/src/index.css` — Tailwind directives
   - `dashboard/src/ble/` — narbisDevice.ts, polarH10.ts, characteristics.ts, parsers.ts (all stubs)
   - `dashboard/src/components/` — ConnectionPanel, SignalChart, BeatChart, MetricsChart, ConfigPanel, PresetBar, RecordingControls, ReplayControls (all stubs returning placeholder divs)
   - `dashboard/src/state/store.ts` — Zustand store with type definitions, no logic
   - `dashboard/src/state/streamBuffer.ts` — stub
   - `dashboard/src/metrics/` — empty stubs for timeDomain, frequencyDomain, coherence, windowing
   - `dashboard/src/recording/` — empty stubs for format, manifest, replay, export
   - `dashboard/src/presets/defaults.json` — empty array

5. **Layout in App.tsx**:
   - Top bar: app title, connection status, recording status
   - Left main: signal charts (placeholders), metrics chart (placeholder)
   - Right sidebar: config panel + presets
   - Bottom: recording controls + status

6. **Reference protocol from project root** — TypeScript imports the protocol files via relative path: `import {...} from '../../protocol/narbis_protocol'`

7. **`.github/workflows/dashboard-build.yml`** — runs `npm install && npm run typecheck && npm run build`

8. **`dashboard/.gitignore`** — node_modules, dist, etc.

## Success criteria

- `cd dashboard && npm install` succeeds
- `npm run typecheck` passes
- `npm run dev` starts Vite server with no errors
- Browser shows layout with all placeholder regions visible
- `npm run build` produces a working `dist/`

## Do not

- Implement BLE yet (Stage 10)
- Implement charts beyond placeholders (Stage 11)
- Implement config panel beyond placeholder (Stage 12)
- Add recording yet (Stage 13)

## When done

Confirm layout renders and recommend Stage 10.
