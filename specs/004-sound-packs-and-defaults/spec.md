# Feature Specification: Sound Packs and New Defaults

**Feature Branch**: `main` (the student asked for this work to land on `main` directly, 2026-10-19)

**Created**: 2026-10-19

**Status**: Implemented

**Input**: User description (translated from Portuguese): "Allow switching the NES Chip sound
pack when listening to the result. In the default settings: fidelity 1, fast arpeggio disabled
and TR bass root disabled. The default pace is full speed."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Hear the arrangement with another sound pack (Priority: P1)

After a run, the visitor picks a sound pack next to the A/B buttons:
- NES chip, the current sound;
- Game Boy;
- Commodore 64;
- Soft synth;
- Plain, the timbre of the original's player.

The arrangement plays again with that pack from the same position. The original does not change,
so A/B still compares the music.

**Independent Test**: arrange Korobeiniki, play it, and switch the pack to Game Boy. The music
continues from the same second with another timbre, and the A button still plays the original.

**Acceptance Scenarios**:

1. **Given** a finished run, **When** the visitor picks another pack, **Then** the
   arrangement's button names the pack, and playback keeps its position and its play or pause
   state.
2. **Given** the NES chip pack, **Then** the samples are exactly those of the chip synthesizer
   (no change from spec 002).
3. **Given** any pack, **Then** the render lasts as long as the NES render of the same
   arrangement, and its loudness is matched to the original's.
4. **Given** a pack chosen once, **When** the visitor arranges again or reloads the page, **Then**
   the same pack is used, if the browser keeps local storage.

### User Story 2 - New defaults (Priority: P1)

A first run uses:
- fidelity weight 1 (it was 0.5);
- P2 without the fast 32nd-note arpeggio;
- TR without the held root;
- the full-speed pace.

**Independent Test**: open the app with no settings changed. The settings show fidelity 1, arp32
and TR root unticked, and pace "full speed". A run never uses arp32 or TR root.

**Acceptance Scenarios**:

1. **Given** the default configuration, **When** the command line or the app runs, **Then** no
   bar uses arp32 or TR root, and fidelity weighs 1.
2. **Given** a run record written before this change (no `allowed` key, such as every committed
   sample), **When** it is loaded with `--config` or imported in the app, **Then** every value is
   allowed, as when the record was made. The samples still rerun to the same plan, fitness and
   MIDI.

## Requirements *(mandatory)*

- **FR-001**: The app MUST offer the five packs in the Result card. Each pack has a name and a
  one-line description.
- **FR-002**: A pack MUST render the same arrangement on the same timeline as the NES chip render
  (same length, notes at the same seconds), deterministically.
- **FR-003**: The NES chip pack MUST be the existing chip synthesizer, unchanged.
- **FR-004**: Switching packs MUST keep the player's position and state, and leave the original
  unchanged.
- **FR-005**: The app SHOULD remember the last pack in local storage, and work without it.
- **FR-006**: `configs/default.json` MUST set `weights.fidelity` to 1.0 and leave `arp32` out of
  `allowed.p2` and `root` out of `allowed.tr`.
- **FR-007**: A loaded or imported run record without `allowed` MUST allow every value, in both
  the command line and the app.
- **FR-008**: The app's default pace MUST be "full".

## Success Criteria *(mandatory)*

- **SC-001**: Each of the five packs renders the Korobeiniki fixture arrangement in under 1 s in
  Node. Every render has the same length, is not silent, and peaks at no more than -3 dBFS.
- **SC-002**: The 10 samples rerun from their records to the same plans, fitness and MIDI bytes.
- **SC-003**: With the defaults, 0 bars of any run use arp32 or TR root.

## Assumptions

- Packs are a playback choice of the app only. The command line keeps its two renderers (General
  MIDI and NES chip), and packs need no Python parity because they are not part of the method
  (fitness or reduction).
- The packs imitate each chip's character with simple oscillators, not cycle-exact emulation:
  - Game Boy: 50% and 25% pulses, a 4-bit 32-step wave channel, and a 15-bit or 7-bit LFSR.
  - Commodore 64: sawtooth and pulse with ADSR envelopes, and a one-pole low-pass on the mix.
- The submitted samples and the abstract used fidelity 0.5 and every value allowed. Their records
  say so, so they stay reproducible.
