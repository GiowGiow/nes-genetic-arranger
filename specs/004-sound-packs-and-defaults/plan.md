# Implementation Plan: Sound Packs and New Defaults

**Branch**: `main` | **Date**: 2026-10-19 | **Spec**: [spec.md](spec.md)

## Summary

**Sound packs** live in a new module, `arranger/src/audio/sound-packs.js`:
- `SOUND_PACKS` lists the packs.
- `renderPack(packId, arrangement, sampleRate)` renders one:
  - "nes" calls `renderChip`;
  - "plain" maps the channels to plain-synth voices (`renderVoices`);
  - "gameboy", "c64" and "soft" use one small oscillator synthesizer, driven by a per-pack table
    of waves, envelopes and drum sounds.
- The length matches `renderChip`: the last note end plus 0.15 s.

The page adds a pack selector to the Result card, keeps each run's raw original render, and
re-matches loudness on a switch.

**Defaults:**
- `configs/default.json` changes.
- `load_config` (Python) and `importConfig` (JS) treat a record without `allowed` as "everything
  allowed".
- The app's default pace becomes "full".

## Technical Context

- **Language:** JS ES2022 modules (app) and Python 3.12 (config only).
- **Dependencies:** none new.
- **Testing:** `node --test`, pytest.
- **Constraints:**
  - The NES render is unchanged, so the Korobeiniki SHA pin and the chip parity of 5e-7 hold.
  - The samples rerun identically (SC-002).

## Constitution Check

| Principle | Check | Status |
|---|---|---|
| I. Reproducibility | Packs are deterministic: the noise comes from the seeded `random.js` with a fixed seed. Old records keep "all allowed" (FR-007), so the samples rerun. The new defaults are recorded in every new `config.json`. | Pass |
| II. Test-first | Failing tests come first: pack lengths, determinism, NES identity, waveforms, the record rule, the defaults. | Pass |
| III. Representation | Packs read the arrangement in beats; seconds appear only in the audio layer. | Pass |
| IV. Learnable code | The module header explains each chip's sound. Exports have JSDoc examples. | Pass |
| V–VII | No new figure is needed. One module, no dependency. | Pass |
| Web App Constraints | Packs are pure functions (no Web Audio); only `player.js` touches audio. | Pass |
| Workflow (feature branches) | Deviation: the student asked for direct commits to `main` in the new repository. | Recorded |

## Project Structure

```text
configs/default.json                    # fidelity 1, allowed without arp32 and TR root
src/config.py                           # record without "allowed" -> every value
arranger/src/audio/sound-packs.js       # NEW
arranger/src/ui/main.js                 # pack selector, re-render on switch, pace "full"
arranger/src/ui/settings-form.js        # importConfig record rule
arranger/index.html                     # pace "full speed" selected
arranger/sw.js                          # precache the new module
arranger/tests/sound-packs.test.js      # NEW
tests/test_config.py, arranger/tests/settings*.test.js
README.md                               # defaults table, packs
```
