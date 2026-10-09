# Guided recording protocols

`ppg_artifact_protocols.json` is the single definition of the guided
recordings that label what an earclip wearer was doing (sitting still, foot
tapping, chewing, talking, cued head turns, ...), so that raw V2.1 earclip
PPG can be used to build and test on-device beat (IBI) detection.

The dashboard (`dashboard/src/guided/`), Android and iOS all bundle this
file **as is** and run it. Every block is written out in full, transitions
included: there is nothing to generate, rotate or randomise, so the three
platforms cannot drift apart as long as they follow the rules below.
The reference implementation is `dashboard/src/guided/runner.ts`, and its
behaviour is pinned by `dashboard/src/guided/__tests__/guided.test.ts`.

## Protocols

| id | length | what |
|---|---|---|
| `ppg_artifact_core` | 6:40 | settle, then still, foot tap, chewing, talking, still |
| `ppg_artifact_full` | 17:10 | core plus cued head turns, jaw clenches, swallows, arm movement, paced breathing, stand/sit, walking in place, clip touches, and a still block at the end |
| `ppg_artifact_short` | 0:53 | plumbing check (`check_only: true`), never training data |

## Block fields

| field | meaning |
|---|---|
| `label` | class label; `settle` and `transition` are never training data |
| `kind` | `settle` · `transition` · `state` (label covers the block) · `cued` (label covers each cue window) |
| `seconds` | planned duration |
| `prompt` | on-screen instruction |
| `say` | spoken instruction (transitions); spoken ~0.45 s after the block's tone |
| `tone` | tone at the block start: `announce`, `go`, `done` (see `tones`) |
| `posture` | `seated` / `standing`, metadata only |
| `cue.every_s` | interval between cues |
| `cue.prompts` / `cue.tones` | cycled per cue (`["Turn left", "Turn right"]` alternates) |
| `cue.lead_s` / `cue.tail_s` | the cued action spans `[cue + lead_s, cue + tail_s]` |
| `cue.marks_event` | `true`: a labelled action; `false`: pacing guidance (breathing) |

Protocol fields: `id`, `version` (bump on ANY change to a protocol's blocks;
ids are permanent), `title`, `summary`, `reference` (Polar H10 advice),
`drop_lead_s` (training hint: drop this many seconds at the start of each
labelled block, the reaction time after the go tone), `check_only`.

## Rules every platform must implement identically

1. **Blocks run back to back** in file order. Block *i+1* starts at the
   instant block *i* is scheduled to end (start + `seconds`), not when a
   timer notices.
2. **Cues**: offsets `k * every_s` for k = 1, 2, ... (never at the block
   start, which already has the go tone), keeping only those with
   `offset + tail_s <= seconds` (the action must end inside the block).
3. **Timestamps are the schedule.** Record each block start/end and cue at
   the time it was scheduled for (when its tone played), never the time a
   timer tick processed it. Catch up in order after a stall.
4. **Pause ends the current block early** (`end_reason = paused`) and
   **resume restarts that block from its beginning** as attempt + 1. A
   labelled block must be one contiguous stretch of the activity.
5. **Skip** ends the block (`skipped`) and starts the next; **stop** ends it
   (`aborted`) and the session.
6. **Device markers**: at every block start, block end and cue, send the
   earclip `NC_OP_MARKER` (CONTROL opcode `0x30`, payload u16 id LE) with

   ```
   id = (block_index + 1) * 1000 + offset
   offset: 0 = block start, 999 = block end, 1 + cue_index = cue
   ```

   (at most 60 blocks per protocol so ids fit a u16). The earclip echoes it
   in its EVENT stream (`EV_MARKER`, source 1 = host) stamped with the
   device clock, the same clock as every raw PPG sample. The firmware
   handles one CONTROL request at a time, so queue CONTROL writes.
7. **Audio modes**: `off` / `tones` / `speech`. Record which one was used:
   following by ear and by eye give different reaction times.
8. **Tones** are short ramped sines (no clicks), scheduled on the audio
   clock ahead of time so they land on the recorded timestamp. Reference
   frequencies are in `dashboard/src/guided/audio.ts`.

## What a recording contains

See `dashboard/src/recording/protocolFormat.ts` (`PROTOCOL_README`) for the
exact `protocol/` folder written into a recording zip: `protocol.json`
(the protocol run, settings, firmware, outcome), `blocks.csv` and
`cues.csv` (host ms and device µs for every boundary and cue, plus a
`use_for_training` flag).
