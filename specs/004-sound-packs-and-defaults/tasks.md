# Tasks: Sound Packs and New Defaults

Test-first: each test task comes before its implementation.

## US2 - New defaults

- [X] T001 [US2] Failing tests in `tests/test_config.py`: the new default `allowed` and fidelity
  1; a record without `allowed` (samples/korobeiniki-s1/config.json) loads every value; a record
  with `allowed` keeps it.
- [X] T002 [US2] `configs/default.json`: `weights.fidelity` 1.0, `allowed.p2` without arp32,
  `allowed.tr` without root. `src/config.py`: the record rule. Update the doctests that print
  default values (`ga.evolution.ga_params`).
- [X] T003 [US2] Failing tests in `arranger/tests/settings-form.test.js`: `importConfig` of a
  record without `allowed` gives every value; with `allowed`, its lists. Then implement in
  `arranger/src/ui/settings-form.js`.
- [X] T004 [US2] Default pace "full": `arranger/src/ui/main.js` state and
  `arranger/index.html` (the selected option). Fix the JS tests that assume the old defaults.
- [X] T005 [US2] Regenerate the fixtures (`uv run src/main.py fixtures`). Only the meter tunes'
  fixed-plan fitness may change (their weights come from the defaults); the sample plans must
  not change.

## US1 - Sound packs

- [ ] T006 [US1] Failing tests in `arranger/tests/sound-packs.test.js`:
  - the 5 packs in order, with names and descriptions;
  - "nes" equals `renderChip`;
  - every pack renders the Korobeiniki plan fixture with the same length, not silent, peak
    ≤ PEAK_LEVEL, deterministic, and each differs from the others;
  - an empty arrangement gives silence of the NES length;
  - the waveform helpers (pulse duty, 4-bit wave levels, sawtooth ramp);
  - `arrangementVoices` maps P1, P2, TR and NO.
- [ ] T007 [US1] Implement `arranger/src/audio/sound-packs.js` and add it to `arranger/sw.js`
  `APP_SHELL`.
- [ ] T008 [US1] Page: a "Sound" selector in the Result card, the arrangement button named after
  the pack, a re-render and loudness match on change (position kept), the raw original kept per
  run, the chosen pack remembered in localStorage (try/catch).
- [ ] T009 [US1] Browser check: arrange Korobeiniki, switch through the 5 packs while playing,
  and check A/B and the run list.

## Polish

- [ ] T010 README: the defaults table, the sound packs in the app section, and the samples' own
  settings (fidelity 0.5, everything allowed).
- [ ] T011 Full suites (`uv run pytest`, `cd arranger && node --test`), then commit and push to
  `main`, and check the Pages deploy.
