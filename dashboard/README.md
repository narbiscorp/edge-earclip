# Narbis Earclip Dashboard

Web Bluetooth tuning dashboard for the Narbis earclip — live PPG, IBI tachogram, HRV metrics, config tweaking, and recording.

## Live URL

**https://narbiscorp.github.io/edge-earclip/**

Auto-deployed from `main` on every push that touches `dashboard/` or `protocol/`.

## Browser support

Web Bluetooth is required, so:

| Browser | Supported |
|---|---|
| Chrome / Edge / Brave (desktop, Android) | ✅ |
| Firefox | ❌ (no Web Bluetooth) |
| iOS Safari | ❌ (Apple does not support Web Bluetooth) |

The hosted site is HTTPS, which Web Bluetooth requires.

## Local development

```bash
cd dashboard
npm install
npm run dev
```

Open the URL Vite prints (defaults to http://localhost:5173/edge-earclip/).

Other scripts:

- `npm run build` — typecheck + production bundle into `dist/`
- `npm run preview` — serve the built bundle locally
- `npm run typecheck` — TypeScript only

## Deployment

Two workflows in `.github/workflows/`:

- **`dashboard-build.yml`** — runs on every push and PR (any branch). Typechecks, builds, uploads `dist/` as a CI artifact. No publish.
- **`dashboard-deploy.yml`** — runs only on `main`. Builds and publishes to GitHub Pages via `actions/deploy-pages@v4`.

Manual re-deploy: GitHub → Actions → **dashboard-deploy** → **Run workflow**.

### One-time Pages setup

In the repo settings: **Settings → Pages → Source: "GitHub Actions"**. The first deploy run after this setting is enabled will succeed.

## TPS sensor (Thought Technology)

Expert mode has a **TPS sensor** button in the header. It opens three screens:

- **Training** — heart rhythm (IBI), temperature, skin conductance, and the combined "Relax" protocol
  (temperature ↑, skin conductance ↓, HRV ↑ → lens darkness), plus the glasses output: **TPS biofeedback**
  (continuous tint, static `0xA5`) or **Breathing + TPS biofeedback** (firmware breath pacer, inhale-peak
  darkness `0xA2` latched once per breath). Selecting an output stops the coherence engine.
- **Diagnostics** — the Web Bluetooth link to the sensor: device information, every visible GATT
  service/characteristic with notification counters, link rates, raw packets, event log.
- **Tunables** — the protocol's knobs; same names and defaults as the iOS/Android apps.

The TPS stream is encrypted and only Thought Technology's mobile SDK decodes it, so on the web the training
screens run from the **simulator** (the same deterministic scenarios the protocol's golden vectors use).
The protocol in `src/tps/tpsProtocol.ts` is vendored from `narbiscorp/edge-ThoughtTechnology/tps/protocol`
— change it there, regenerate the vectors, and re-copy.

## Notes

- Vite `base` is set to `/edge-earclip/` so all asset URLs resolve correctly under the Pages subpath. If the repo is ever renamed, update `base` in `vite.config.ts`.
- `plotly.js` requires the `buffer/` → `buffer` Vite alias (also in `vite.config.ts`); removing it breaks `vite build`.
