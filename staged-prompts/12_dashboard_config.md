# Stage 12 — Dashboard: Config panel + presets

## Task

UI for live firmware tuning. Save and load presets.

## Prerequisites

Stage 11 complete.

## What to build

1. **`dashboard/src/components/ConfigPanel.tsx`** — collapsible sections matching CLAUDE.md layers:
   - Sensor & LED
   - DC Removal
   - Bandpass Filter
   - Elgendi Peak Detection
   - IBI Validation
   - Signal Quality
   - Transport & Mode
   - Diagnostics
   - Each parameter: appropriate widget (slider, dropdown, toggle, range tuple)
   - Reset-to-default per section + reset-all
   - Section expand/collapse, persisted in localStorage

2. **Live apply**:
   - On slider change (debounced 300ms): write config to firmware
   - Write feedback: spinner during, checkmark on success, X on failure
   - Optimistic UI

3. **`dashboard/src/components/PresetBar.tsx`**:
   - Dropdown of saved presets
   - "Save current as preset" → modal with name input
   - "Apply preset" → writes to firmware
   - Export preset → JSON download
   - Import preset → file picker + JSON parse
   - Built-in presets: Default, Resting/Coherence, Active/Motion, Cold Extremities, H10 Validation
   - User presets in IndexedDB

4. **`dashboard/src/presets/defaults.json`** — built-in presets with reasonable starting values

5. **Diagnostic stream toggles** in Diagnostics section

6. **Validation**:
   - Client-side range validation from protocol
   - Refuse invalid configs
   - Highlight invalid fields red

## Success criteria

- Every field in `narbis_runtime_config_t` has a UI control
- Slider change → firmware update within 1 second
- Effect visible on charts immediately
- Presets save/restore work
- Built-in presets all produce reasonable behavior

## When done

Report apply latency, any parameters not applying correctly, any UI sluggishness.
