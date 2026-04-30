/// <reference types="vite/client" />

// Build-time constant injected by vite.config.ts `define`. A timestamp
// like 20260430183142 — visible in the header so the running app can
// prove which bundle it is.
declare const __BUILD_ID__: string;
