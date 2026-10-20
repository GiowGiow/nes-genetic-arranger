# Tasks: Song Browser, Song Server and Channel Mixer

**Input**: design documents in `specs/005-song-browser-server-mixer/`: spec, plan, research,
data model, contracts, quickstart.

**Tests**: test-first per constitution 2.0.0 principle II. Each test task comes before its
implementation task and must fail first.

**Paths**: repository-relative. The app is in `arranger/` (tests in `arranger/tests/`), the CLI in
`src/`, the server in `server/`, and Python tests in `tests/`.

**The Session**: its tune data must never be read by an agent. Tests use synthetic JSON written
for the test.

## Phase 1: Setup

- [ ] T001 Vendor three.js 0.186.1 `build/three.module.min.js` into `arranger/vendor/three/`, with
  its `LICENSE` and a `README.md` recording version, URL and SHA-256. Add an import map for
  `three` in `arranger/index.html`.
- [ ] T002 [P] Add the uv dependency group `server` (`starlette`, `uvicorn`, `httpx`) with
  `uv add --group server`. Add `server/__init__.py` and `tests/server/__init__.py`, and update
  `pyproject.toml` pytest `pythonpath` to include the repository root for `server`.
- [ ] T003 [P] Create `arranger/data/catalog/` and `data/catalog/abc/`, and add
  `data/raw/pdmx/`, `data/raw/nottingham/` and `data/raw/wikidata/` under the ignored
  `data/raw/` (check `.gitignore`).

## Phase 2: User Story 1 - Balance the channels while listening (P1)

**Goal**: four live level controls with measured defaults, for every pack, plus a WAV download.

**Independent test**: arrange Korobeiniki, move each slider while playing, switch packs, reload,
and download the WAV (quickstart step 1).

- [X] T004 [P] [US1] Write failing tests in `arranger/tests/stems.test.js`:
  - `renderChipStems` returns P1, P2, TR and NO of equal length.
  - Mixing them with `CHANNEL_GAINS` and the peak scale equals `renderChip` sample for sample.
  - The Korobeiniki defaults SHA pin still holds.
- [X] T005 [US1] Implement `renderChipStems` in `arranger/src/audio/chip-synth.js` and rebuild
  `renderChip` on it with the same float operations (FR-006).
- [X] T006 [P] [US1] Write failing tests in `arranger/tests/sound-packs.test.js` for
  `renderPackStems(packId, arrangement, rate)`:
  - every pack gives four stems of `renderLength`;
  - plain maps melody, others[0], others[1] and drums to P1, P2, TR and NO;
  - stems mixed at 0 dB equal `renderPack` up to the peak scale.
- [X] T007 [US1] Implement `renderPackStems` in `arranger/src/audio/sound-packs.js`, with
  `renderPack` built on it.
- [X] T008 [P] [US1] Write failing tests in `arranger/tests/mixer.test.js`:
  - `dbToGain`; −60 dB and mute give 0.
  - `DEFAULT_LEVELS`.
  - `mixStems(stems, levels)` sums with the gains and peaks at −3 dBFS.
  - `readLevels` and `storeLevels` round-trip, and fall back on bad JSON.
  - Levels are clamped to [−60, +6].
- [X] T009 [US1] Implement `arranger/src/audio/mixer.js`, with a module header on gain staging
  (research R2).
- [X] T010 [P] [US1] Write failing tests in `arranger/tests/wav.test.js`:
  - the RIFF/WAVE header fields (mono, 16-bit, rate, sizes);
  - clamping and rounding of samples;
  - byte length = 44 + 2·n.
- [X] T011 [US1] Implement `arranger/src/audio/wav.js` `encodeWav(samples, sampleRate)`.
- [X] T012 [US1] Write `arranger/tests/mixer-defaults.test.js` and use it to set the defaults:
  1. Measure gated loudness per stem on the 8 example arrangements (seed 1, default settings),
     and print the gaps.
  2. Set `DEFAULT_LEVELS` in `mixer.js` so that TR and NO sit 3 dB under P1 and P2 sits 1 dB
     under P1.
  3. Assert that every gap is within 4 dB (SC-001).
  4. Fill in the R1 table in `research.md`.
- [ ] T013 [US1] Extend `arranger/src/audio/player.js`:
  - `load` accepts `arrangement` as either one buffer or `{P1, P2, TR, NO}` stems;
  - each stem gets its own source and gain into an arrangement bus;
  - a `DynamicsCompressorNode` limiter (research R2) sits after the bus;
  - `setLevels(levels)` ramps over 10 ms;
  - A/B, seek and position are unchanged.

  Update `arranger/tests/player.test.js` if it exists, or add a fake-AudioContext test for
  `setLevels` ramps.
- [ ] T014 [P] [US1] Write failing tests in `arranger/tests/mixer-panel.test.js` (DOM fake, as in
  the other UI tests):
  - four sliders labeled P1, P2, Bass and Drums, in the channel colors;
  - mute toggles and Reset;
  - `onChange` fires with levels.
- [ ] T015 [US1] Implement `arranger/src/ui/mixer-panel.js` and its styles in `arranger/style.css`.
- [ ] T016 [US1] Wire everything in `arranger/src/ui/main.js`:
  - The run render keeps the stems per run.
  - Loudness matching runs on the default mix, and the factor scales the bus.
  - A pack switch re-renders the stems.
  - The mixer panel calls `player.setLevels` and `storeLevels`.
  - Add the "Audio (WAV)" download using `mixStems` + `encodeWav`, disabled when everything is
    muted.

  Add `src/audio/mixer.js`, `src/audio/wav.js` and `src/ui/mixer-panel.js` to `arranger/sw.js`
  `APP_SHELL`, and update `arranger/tests/service-worker.test.js`.

## Phase 3: User Story 2 - Preview a track from where it plays (P1)

**Goal**: the track preview starts at the first note and skips long rests.

**Independent test**: preview a late-entering track; sound within 1 s (quickstart step 2).

- [X] T017 [P] [US2] Write failing tests in `arranger/tests/plain-synth.test.js` for
  `previewWindow(sounding, maxBars = 8, gapBars = 2)` (research R4):
  - it starts at the first sounding bar;
  - it skips runs of ≥2 silent bars and keeps shorter rests;
  - it stops at 8 sounding bars;
  - it returns an empty list when nothing sounds.
- [X] T018 [US2] Implement `previewWindow` in `arranger/src/audio/plain-synth.js`, plus a helper
  that renders a list of bar ranges back to back.
- [ ] T019 [US2] Rewrite `previewTrack` in `arranger/src/ui/main.js`:
  - compute the bars where the track sounds in the excerpt;
  - fall back to the whole song (naming the first bar in the hint);
  - say so when the track has no notes.

## Phase 4: Foundational for the catalog (blocks US4, US6, US3)

- [ ] T020 [P] Write failing tests in `tests/catalog/test_analysis.py`:
  - a Python `rank_melody_tracks` / `melody_score` gives the same ranking as the app's
    `rankMelodyTracks` on the committed MIDI fixtures. Store the expected JS rankings in
    `arranger/tests/fixtures/melody-ranking.json`, written by a small node script.
  - `analyze_midi(path)` returns facts with every data-model field and no notes.
- [ ] T021 Implement `src/catalog/analysis.py`:
  - the melody ranking port;
  - `analyze_midi` (64-bar cap, one section "A", overrides as the MIDI examples);
  - `sprite_seed(source, id)`.
- [ ] T022 [P] Write failing tests in `tests/catalog/test_collections.py` for `abc_tune_to_midi`
  (research R10), using a synthetic tune:
  - repeats and endings are expanded;
  - a pickup is padded to a full bar;
  - chord symbols become an accompaniment track;
  - the reduced lead sheet reads back with the existing ABC reader.
- [ ] T023 Implement `abc_tune_to_midi` and `reduce_tune` in `src/catalog/collections.py`.

## Phase 5: User Story 4 - Open any catalog song in one click (P1)

**Goal**: MPB songs open as ABC lead sheets through the server.

**Independent test**: with the server running, open an MPB song; its lead sheet equals the CLI's
reduction (quickstart step 4).

- [ ] T024 [US4] Write failing tests in `tests/catalog/test_mpb_catalog.py` for
  `write_mpb_catalog(dataset_dir, out)`, using a temporary dataset made of the MIDI fixtures and
  a small `metadata.csv`:
  - the envelope and entry fields follow `contracts/catalog-files.md`;
  - every entry has a server route or an `error`;
  - output is sorted and deterministic;
  - no note data appears.
- [ ] T025 [US4] Implement `catalog analyze --dataset` (`src/catalog/analysis.py` writer +
  `src/catalog/crawl.py` subcommands). Keep the old crawl as `catalog crawl`. Run it on
  `~/ufmg/music_gen/datasets/beakauffmann/`, which writes `arranger/data/catalog/mpb.json`.
- [ ] T026 [P] [US4] Write failing tests in `tests/server/test_fetcher.py` with a fake transport:
  - hosts off the allow-list are refused;
  - private, loopback, link-local and CGNAT addresses are refused after DNS;
  - redirects are followed only within the list;
  - 2 MB cap, timeout, sniffing;
  - ≥1 s spacing per host (fake clock);
  - LRU with TTL and size cap.
- [ ] T027 [US4] Implement `server/fetcher.py`.
- [ ] T028 [P] [US4] Write failing tests in `tests/server/test_app.py` with `TestClient` and a
  fake fetcher:
  - `/health`;
  - `/songs/mpb/<id>.abc` returns the same ABC as the CLI reduction of the fixture MIDI;
  - 404 for unknown or denylisted ids, 409 on SHA mismatch, 422, 502;
  - CORS only for the allowed origins;
  - 429 with `Retry-After`;
  - no IP or query in the logs.
- [ ] T029 [US4] Implement `server/app.py` (routes, CORS, rate limit), `server/sources/mpb.py`
  and `server/denylist.json`. `uv run --group server server/app.py` serves on port 8765.
- [ ] T030 [US4] App side, in `arranger/src/core/sources.js`:
  - add `serverUrl()` (localhost when served from localhost, else the production host);
  - add `openEntry(entry)` for the `abc` and `server` routes.

  Write its tests first in `arranger/tests/sources.test.js`: routes, offline message, SHA
  mismatch message.

## Phase 6: User Story 6 - More songs in the repository (P2)

**Goal**: redistributable ABC lead sheets: public-domain MPB, Nottingham and the PDMX subset.

**Independent test**: the commands regenerate the committed files with no diff.

- [ ] T031 [P] [US6] Write failing tests in `tests/catalog/test_authors.py`:
  - splitting composer strings;
  - SPARQL batching (fake HTTP);
  - "unknown" for no match or disagreeing matches;
  - `is_public_domain(authors, year=2026)` with 1955 as the limit.
- [ ] T032 [US6] Implement `src/catalog/authors.py` and `catalog authors`. Run it, which writes
  `data/catalog/authors.json`.
- [ ] T033 [P] [US6] Write failing tests in `tests/catalog/test_collections.py` for the writers:
  - provenance headers;
  - license files copied;
  - catalog entries with `abc` routes;
  - the PDMX filter of research R12 on a synthetic CSV.
- [ ] T034 [US6] Implement `catalog public-domain`, `catalog nottingham` and `catalog pdmx` in
  `src/catalog/collections.py`. Download the inputs into `data/raw/`, run the commands, and
  commit `data/catalog/abc/**` and `arranger/data/catalog/{public-domain,nottingham,pdmx}.json`.
- [ ] T035 [US6] Write `arranger/data/catalog/examples.json` with `catalog examples`, from
  `data/sources.json`.

## Phase 7: User Story 3 - The PS2 memory-card song browser (P1)

**Goal**: the 3D browser replaces the Song card's tabs.

**Independent test**: Enter Korobeiniki in ≤4 keys, with a screen reader, and without WebGL
(quickstart step 5).

- [ ] T036 [US3] **Design previews (gate).** Build 2–3 standalone visual prototypes of the
  memory-card browser (cards screen, save-icon grid, details panel) with sample data. Show them
  to the student and record the chosen direction in `research.md` R6. T040–T044 wait for this
  choice.
- [ ] T037 [P] [US3] Write failing tests in `arranger/tests/sprites.test.js`:
  - the same seed gives the same 16×16 grid;
  - left-right mirror symmetry;
  - palette from key (major light, minor dark);
  - an outline around the body.
- [ ] T038 [US3] Implement `arranger/src/ui/sprites.js` (`spriteFor(entry)`, `drawSprite(ctx, sprite,
  x, y, scale)`).
- [ ] T039 [P] [US3] Write failing tests in `arranger/tests/sources.test.js`:
  - loading cards lazily;
  - searching across loaded cards with the existing ranking;
  - `windowAround(index, total, 40)`.
- [ ] T040 [US3] Implement the rest of `arranger/src/core/sources.js` (card list, lazy load,
  search, window).
- [ ] T041 [P] [US3] Write failing tests in `arranger/tests/song-browser.test.js` (DOM fake):
  - states cards ⇄ songs ⇄ details;
  - keyboard map (arrows, Home/End, Enter, Escape, `/`);
  - listbox `aria-activedescendant`;
  - the insert-disc slot opens the file input;
  - the 2D fallback grid when no WebGL;
  - Arrange calls `onOpen(entry)`.
- [ ] T042 [US3] Implement `arranger/src/ui/song-browser.js` and its styles in
  `arranger/style.css`, following the chosen preview.
- [ ] T043 [US3] Implement `arranger/src/ui/browser-scene.js` (three.js), following research R6
  and the chosen preview:
  - cards row, vinyl save icons with sprite labels;
  - bobbing, spin and glow on the selection;
  - pillars and particles;
  - low-res canvas;
  - reduced motion;
  - context loss falls back to the 2D grid.
- [ ] T044 [US3] Replace the tabs in `arranger/index.html` and `arranger/src/ui/input-panel.js`:
  - remove `arranger/src/ui/catalog-panel.js` and its test;
  - mount the browser in `arranger/src/ui/main.js`; `onOpen` uses `sources.openEntry` and then
    `inputPanel.readFile`;
  - update `arranger/sw.js`, `arranger/tests/service-worker.test.js` and
    `arranger/tests/examples.test.js`.

## Phase 8: User Story 5 - Search across sources and external sites (P2)

**Goal**: one search over local cards, The Session (browser) and the server's sites.

**Independent test**: search "polka"; open a The Session tune, a Mutopia or BitMidi file, and an
IMSLP link (quickstart step 4).

- [ ] T045 [P] [US5] Write failing tests in `tests/server/test_sources.py` for the Mutopia,
  BitMidi and IMSLP parsers, using synthetic fixtures in `tests/server/fixtures/` shaped like each
  documented response. Each must yield normalized results (data model "Search result").
- [ ] T046 [US5] Implement `server/sources/mutopia.py`, `bitmidi.py` and `imslp.py`, then
  `/search` and `/files/<source>/<id>` in `server/app.py`. Add tests in
  `tests/server/test_app.py` first:
  - per-source status;
  - 30 results per source at most;
  - 413/415 errors.
- [ ] T047 [P] [US5] Write failing tests in `arranger/tests/thesession.test.js` with **synthetic**
  JSON:
  - search URL;
  - tune JSON to ABC (meter by type, key, pickup rest);
  - unsupported types marked;
  - no network.
- [ ] T048 [US5] Implement `arranger/src/core/thesession.js`, and the abcjs MIDI route in
  `arranger/src/core/sources.js` (research R10).
- [ ] T049 [US5] Stream external results into the Search card in `arranger/src/ui/song-browser.js`:
  - mark each result with its source and license;
  - link-only results open their page;
  - an offline server shows a notice while local and The Session results stay.

## Phase 9: Deployment

- [ ] T050 [P] Write the `Dockerfile` (research R16) and `.dockerignore`. Check that
  `docker build` runs locally and the container answers `/health`.
- [ ] T051 [P] Add `.github/workflows/server-image.yml`: test, build and push
  `ghcr.io/giowgiow/nes-arranger-server:<sha>` and `:main` on pushes to `main` that touch
  `server/`, `src/` or the catalog.
- [ ] T052 [P] Write `deploy/homelab/nes-arranger/`:
  - namespace, deployment, service, network-policy, ingress-external and kustomization;
  - a `README.md` with the FRP `customDomains` and Pi-hole `local=` edits, and the public-API
    exception note for the homelab `docs/security.md`.
- [ ] T053 Ask the student for explicit OK, then copy the manifests into
  `GiowGiow/homelab-kubernetes-server`, with the FRP and Pi-hole edits in the same commit, and
  push. Check `/health`, CORS and the private-IP refusal from outside.

## Phase 10: Polish

- [ ] T054 [P] README: new sections on the song browser, the server, the sources with their
  licenses (checked 2026-10-20), the public-domain rule, takedown contact, the mixer and the WAV
  download. Remove the download-and-drop text.
- [ ] T055 Run the quickstart in the built-in browser at 375 px and desktop:
  - reduced motion;
  - no WebGL (`?no-webgl`);
  - server offline;
  - mixer and preview.

  For The Session, count results through JS only.
- [ ] T056 Run all suites (`uv run pytest`, `cd arranger && node --test`). Check that samples and
  parity fixtures are unchanged (`git status`). Mark the spec as implemented.

## Dependencies

- Setup comes first.
- US1 (T004–T016) and US2 (T017–T019) are independent of everything else.
- Phase 4 blocks US4, US6 and US3's catalog data.
- US4's server (T026–T029) blocks US5's server sources.
- T036 (previews, student's choice) blocks T042–T044.
- Deployment needs US4 and US5.
- Polish comes last.

## Parallel plan (subagents)

| Worker | Tasks | Files |
|---|---|---|
| Main session | T001–T003, T036 previews, US1 wiring T013–T016, T019, T044, T049, deploy, polish | `arranger/index.html`, `ui/main.js`, `audio/player.js`, `sw.js`, docs |
| Agent A (audio) | T004–T012 | `audio/chip-synth.js`, `audio/sound-packs.js`, `audio/mixer.js`, `audio/wav.js`, tests |
| Agent B (preview + sprites) | T017–T018, T037–T038 | `audio/plain-synth.js`, `ui/sprites.js`, tests |
| Agent C (catalog Python) | T020–T025, T031–T035 | `src/catalog/**`, `tests/catalog/**`, catalog data |
| Agent D (server) | T026–T029, T045–T046, T050 | `server/**`, `tests/server/**`, `Dockerfile` |
| Agent E (browser UI, after T036) | T039–T043, T047–T048 | `core/sources.js`, `core/thesession.js`, `ui/song-browser.js`, `ui/browser-scene.js`, tests |

**Rules for parallel agents:**
- Each agent owns its files and never commits.
- The main session commits only when no agent is writing, because the pre-commit stash can
  corrupt files that are being written.
- No agent reads The Session tune data.

## Implementation strategy

- **MVP:** US1 + US2, the fastest value: they fix the mix and the preview today.
- **Next:** catalog data and the server (US4).
- **Then:** the browser (US3) after the preview gate.
- **Last:** search (US5) and the collections (US6).
