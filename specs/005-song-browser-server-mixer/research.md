# Research: Song Browser, Song Server and Channel Mixer

Sources were checked on 2026-10-20. The approved design is in the plan. Decisions are below.

## R1. Default channel levels (measured, then set by ear)

- **Decision (2026-10-20):** perceptual defaults, as offsets in dB on top of the chip's own
  mixer gains (`CHANNEL_GAINS`): `DEFAULT_LEVELS` is P1 0, P2 -1, TR +4 and NO +10 dB.
  - P1 stays at the chip's balance, and P2 sits 1 dB under it, because it is the harmony.
  - `MAX_DB` is +12 dB, so every slider keeps room to boost, the drums included (2 dB over
    their default). `MIN_DB` stays -60 dB, shown as Off.
- **Why the measured rule was dropped:** the first rule set the defaults from gated loudness
  (TR and NO 3 dB under P1, P2 1 dB under it, averaged over the examples). It gave P1 -9,
  P2 -5.5, TR -13 and NO +6 dB, which lowers the bass by 4 dB against the melody, while the
  student hears the bass and the drums as too quiet.
  - The triangle bass sits at 41 to 155 Hz. Laptop speakers barely reproduce that range, and
    the ear is less sensitive there. Gated RMS has no frequency weighting, so it already puts
    the bass 0.9 dB over the melody and cannot see the problem.
  - The drums are short hits: they measure 16.8 to 18.9 dB under P1 in every example.
- **What the measurement still does:** `arranger/tests/mixer-defaults.test.js` prints the gaps
  of the 8 examples at the chip's balance and with the defaults, and bounds the defaults on
  every example:
  - TR between 2 dB under and 7 dB over P1;
  - NO at least 8 dB closer to P1 than at the chip's balance;
  - the default mix, scaled to -3 dBFS as the WAV download is, never clips.
- **Confirmation by ear:** the student confirms the defaults by listening (story 1, independent
  test 1). A change after listening updates `DEFAULT_LEVELS` and this section; the test bounds
  stay.
- **Spec impact:** FR-003 and SC-001 bound the gaps at 4 dB of gated loudness. With these
  defaults the drums measure 6.8 to 8.9 dB under P1 and the bass up to 5.7 dB over it, so those
  lines need the bounds above.
- **Rationale for offsets on top of the chip gains:** the chip gains are the linear NES mixer
  approximation (TR 1.13, NO 0.66 relative to a pulse). An offset fixes the balance for every
  pack, because packs map to the same four stems.
- **Alternatives considered:**
  - Changing `CHANNEL_GAINS` would break the chip parity with the CLI and the Korobeiniki pin.
  - A K-weighted LUFS meter weighs frequencies closer to the ear, but needs a filter not used
    anywhere else, and it still would not model a laptop speaker. Listening decides; the gated
    RMS already in `loudness.js` is enough to keep the defaults in bounds.

| Stem | Gap to P1 at the chip's balance (dB) | First rule's offset (dB, dropped) | Default offset (dB) | Gap with the defaults (dB) |
|---|---|---|---|---|
| P2 | -4.32 | +3.5 | -1 | -5.32 |
| TR | +0.88 | -4.0 | +4 | +4.88 |
| NO | -17.80 | +15.0 | +10 | -7.81 |

- Gaps are gated RMS (`gatedRms`, 400 ms blocks) of the NES stems with `CHANNEL_GAINS`, at
  44.1 kHz, averaged over the 8 examples. The arrangements are the committed plan fixtures
  `arranger/tests/fixtures/plans/<example>-s1.json` (seed 1, with the samples' settings).
- Offsets are relative to P1, whose default is 0 dB.
- With the defaults, TR measures from +4.05 dB (Ievan Polkka) to +5.68 dB (Aquarela) against
  P1, and NO from -6.77 dB (Mulher de Fases) to -8.91 dB (Ievan Polkka). The default mix of
  every example peaks at -3.00 dBFS.

## R2. Stems and live gain changes

- **Decision:**
  - `renderChipStems` returns the four channels before the chip gains and the peak scale, on
    one scale.
  - `renderChip` and `renderChipStems` share the note scheduling and the synthesis.
    `renderChip` still adds each note straight into one mix with its channel gain, so its
    output stays byte-identical (a test compares it with the pinned SHA). The stems summed
    with `CHANNEL_GAINS` and scaled to -3 dBFS match `renderChip` within 1e-6
    (`arranger/tests/stems.test.js`).
  - The player builds its graph once per AudioContext: one `GainNode` per channel, into an
    arrangement bus, then a `DynamicsCompressorNode` used as a limiter (threshold -1 dB, knee
    0, ratio 20, attack 3 ms, release 100 ms), then the arrangement's A/B switch gain and the
    destination. The original goes through its own switch gain to the destination.
  - Each play or seek creates one `AudioBufferSourceNode` per stem, into its channel gain. An
    arrangement given as one buffer goes straight into the bus.
  - Levels ramp over 10 ms, like the A/B switch.
- **Loudness matching** against the original is computed once per render, on the mix at the
  default levels (`matchMixLoudness` in `mixer.js`). The resulting factor is the bus gain, so
  the visitor's changes are relative to a matched mix.
- **Rationale:** gains on stems change the mix instantly without re-rendering. The limiter
  holds the peaks near -1 dBFS when the visitor boosts channels, up to +12 dB on all of them.
- **Alternative considered:** re-rendering the mix on every change gives clicks and restarts
  playback.

## R3. WAV download

- **Decision:** mono 16-bit PCM at the audio context's rate. The stems are mixed offline with
  the current gains (`mixer.js` `mixStems`) and scaled to a -3 dBFS peak. `wav.js` writes the
  44-byte RIFF header, then the samples, clamped and rounded.
- The download is disabled, with a note, when every channel is muted.

## R4. Preview window

- **Decision:** `previewWindow(bars, maxBars = 8, gapBars = 2)`.
  - The input is, for each bar of the excerpt, whether the track sounds in it.
  - It returns the list of bar ranges to play, starting at the first sounding bar. A run of
    `gapBars` or more silent bars is skipped. It stops after `maxBars` sounding bars.
  - Silent stretches shorter than `gapBars` stay, so short rests keep the phrasing.
  - When no bar of the excerpt sounds, the caller tries the whole song and names the first bar.
- **Rationale:** a pure function over booleans is easy to test. The renderer then plays the
  ranges back to back.

## R5. Sprites

- **Decision:** a 16×16 sprite, mirrored left to right.
  - Each of the 8×16 half-cells is drawn from `createRandom(spriteSeed)` as empty, body or
    accent, then given a dark outline.
  - The palette comes from the 2C02 NES palette: a hue family from the key's tonic (12 pitch
    classes on the NES hue wheel), light for major and dark for minor. The accent is one of
    the four channel colors.
  - The sprite seed is the first 32 bits of SHA-256(`source:id`), computed when the catalog is
    written and stored in the entry, so the same song gets the same sprite everywhere.
- **Rationale:** symmetric random sprites read as creatures or emblems, like save icons.
  Seeding from the catalog keeps them deterministic (principle I).

## R6. 3D catalog scene (decided with the student through previews, 2026-10-20)

- **Rounds:** four rounds of previews in the real page.
  1. A PS2 memory-card screen (cards, then songs) with three song layouts: grid, carousel,
     sleeves. The student chose the **grid of vinyl records**.
  2. The catalog must be a section of the existing page, not a full-screen browser. The 3D must
     feel part of the page. No "Memory card", "Save data" or "Browser" text, since the PS2 is
     only the inspiration. No source site names in the interface.
  3. No source tabs: **one catalog**, examples first, then pages of records.
  4. The glow must cover the whole Song card, not stop at the 3D area's edge.
- **Decision:**
  - three.js 0.186.1 `three.module.min.js`, vendored (MIT) and imported through an import map.
  - **Canvas:** a transparent WebGL canvas (`alpha: true`) inside the Song card, with no box,
    border or sky of its own.
  - **Lighting:** ambient light, a white key light, and soft rim lights in P1 blue and P2
    orange.
  - **Particles:** about 90 faint particles in the four channel colors.
  - **Records:** each record is a 28-segment disc with a canvas texture (grooves, a label in a
    channel color, the 16×16 sprite). Nearest filtering, rendered at 0.6× device pixels.
  - **Selection:** the selected record moves forward, grows, spins like a turntable, sways and
    has an additive halo. The others bob gently.
  - **Grid:** pages of 5×3 (3×3 under 560 px).
  - **Card glow:** radial gradients in the channel colors on the Song card's background, so it
    is never cut.
- **Alternatives rejected by the student:** a full-screen browser, source cards or tabs, the
  carousel, sleeves, PS2 labels, and showing source names or an "Original page" link.

## R7. Fallback and accessibility

- **Decision:**
  - `song-browser.js` owns the state (card, selection, query) and a DOM listbox
    (`role=listbox`, `aria-activedescendant`), which stays the source of truth.
  - The 3D scene only draws that state.
  - Without WebGL (or after `webglcontextlost`), the listbox is shown as a 2D grid of sprite
    canvases with the same handlers.
  - Under `prefers-reduced-motion`, there is no bobbing, spinning or camera tweening.

## R8. Catalog files

- **Decision:** one JSON file per card in `arranger/data/catalog/`: `examples.json`, `mpb.json`,
  `public-domain.json`, `nottingham.json`, `pdmx.json`.
- The entry schema is in [contracts/catalog-files.md](contracts/catalog-files.md).
- Examples are built from `data/sources.json`, as `examples.js` does today, and the old
  `arranger/data/catalog.json` is replaced by `mpb.json`.
- Files load lazily when a card opens or a search needs them. The service worker caches them at
  runtime, not in the app shell.

## R9. The Session (browser side only)

- **Decision:** `core/thesession.js` builds the API URLs and turns API JSON into an ABC tune.
  - Search: `https://thesession.org/tunes/search?q=<q>&format=json&perpage=50`.
  - Tune: `https://thesession.org/tunes/<id>?format=json`. Both send CORS `*`; the raw `/abc`
    endpoint does not.
  - The ABC is assembled from the setting's `abc` body, the tune name, its type (which gives
    the meter, e.g. jig 6/8, reel 4/4, polka 2/4, slip jig 9/8, waltz 3/4, slide 12/8) and its
    key.
  - Types with an unsupported meter (three-two 3/2) are listed as "cannot be arranged".
  - The tune is then read through the ABC-to-MIDI route (R10).
- **License:** the dump's license forbids processing with language models. The agent never
  fetches or reads tune data. Tests use synthetic JSON written for the test, and browser checks
  count results through JavaScript.
- **Alternative considered:** a server proxy is unnecessary (CORS is open) and would be the
  server touching their data.

## R10. ABC collections with repeats, pickups or no chords

- **Finding:** the lead-sheet ABC reader refuses repeat signs, pickup bars and tunes without
  chord symbols, by design (spec 001). Folk collections (Nottingham, The Session) have all
  three.
- **Decision:** route such tunes through the MIDI reduction, which already detects chords and
  has JS/Python parity:
  1. Expand the repeats.
  2. Pad a pickup with a leading rest to a full bar.
  3. Write the chord symbols as an accompaniment track.
  4. Reduce with melody track 0.
- **Python** (`src/catalog/collections.py`): music21 parses the tune, then `expandRepeats()`,
  pads `paddingLeft`, realizes the chord symbols as chords, writes MIDI, and calls
  `read_lead_sheet_midi`. The committed result is a plain lead sheet (`lead_sheet_to_abc`)
  that the existing ABC reader accepts.
- **Browser** (The Session): abcjs's `synth.getMidiFile` writes the MIDI (repeats expanded,
  chord symbols as accompaniment). Before that, a leading `z` rest of
  `bar − tune.getPickupLength()` is inserted. The bytes then enter the existing MIDI flow.
- **Found while building the browser side:** abcjs `getPickupLength()` returns 0 when a tune
  starts with `|:`. `abcToMidi` therefore measures the first bar itself and writes the leading
  rest before the `|:` sign, so a repeat goes back to the pickup and not to the rest. A test
  checks that downbeats stay on bar lines after a repeat.
- **Rationale:** no new reduction logic. Chords come from the written symbols when present, and
  from the melody otherwise.

## R11. Public domain from Wikidata

- **Decision:**
  - Composer strings are split on ", " and " e ".
  - Each name is matched with SPARQL against humans (`wdt:P31 wd:Q5`) whose pt or en label or
    alias equals the name exactly, preferring those with a music occupation.
  - A name with no match, or with matches that disagree on the death year, is **unknown**.
  - A song is public domain only if every author has a death year ≤ 1955 (2026 − 71; life + 70
    full years).
  - `data/catalog/authors.json` records name, QID, death year and the query date.
  - Queries are batched (50 names with `VALUES`), at least 1 s apart, with the project
    User-Agent, and cached in `data/raw/wikidata/`.
- **Rationale:** conservative by construction (constitution 2.0.0). The QIDs make each decision
  auditable.

## R12. PDMX subset

- **Decision:** from `PDMX.csv`, keep rows that meet every condition:
  - `subset:no_license_conflict` and `is_best_unique_arrangement` are true;
  - `song_length.bars` is between 8 and 256;
  - the composition is free: either `composer_name` resolves (R11) with every author dead by
    1955, or `is_original` is true (the uploader's own work, released by them as PD or CC0).
- Then rank by rating and number of ratings, and keep at most 2,000. The MIDI from `mid.tar.gz`
  is reduced with the suggested melody track (R13).
- Committed ABC carries the PDMX license fields and attribution. The dataset is CC-BY 4.0.
- **Rationale:** uploader license labels are unreliable for covers of popular songs, so the
  composer check carries the decision. 2,000 tunes keep the repository small (about 6 MB).

## R13. Analysis facts for MIDI files (MPB and PDMX)

- **Decision:**
  - The melody track is chosen by a Python port of the app's `rankMelodyTracks` and
    `melodyScore`. A parity test runs on the MIDI fixtures.
  - The bar range is the first 64 bars that hold notes (`excerpt_bars` capped).
  - Sections: one "A" section; phrase length 4.
  - The GA overrides are the same as for the MIDI examples (`max_generations` 4000,
    `stagnation_window` 400).
  - The reduction gives key, tempo, meter and bar count. A file the reader refuses is recorded
    with `error` and no route.
  - The SHA-256 is of the exact bytes.
- **Rationale:** the same facts let the server reproduce the lead sheet exactly, and let the
  browser show bars, tempo and meter before loading.

## R14. Song server

- **Decision:** Starlette app, run by uvicorn.
- **Routes:** see [contracts/server-api.md](contracts/server-api.md).
- **`Fetcher`:**
  - Only `https` to allow-listed hosts.
  - DNS resolution is checked against private, loopback, link-local and CGNAT ranges
    (`ipaddress`).
  - Redirects are followed manually, only within the allow-list.
  - 2 MB cap (streamed) and 10 s timeout.
  - The content is sniffed: `MThd` for MIDI, `X:` for ABC, JSON or HTML for search pages.
  - At least 1 s between requests to the same host. User-Agent
    `nes-genetic-arranger/1.0 (+https://github.com/GiowGiow/nes-genetic-arranger)`.
  - In-memory LRU cache: 200 MB, 24 h TTL.
- **Visitor limits:** in-memory token buckets per IP (60 requests/min, of which 20 may be
  searches), keyed by the first `X-Forwarded-For` hop, which Traefik sets.
- **CORS:** `https://giowgiow.github.io` and `http://localhost:*`. GET only. No cookies.
- **No logs:** uvicorn access log is off; errors are logged without IPs or queries.

## R15. External sources on the server

- **Mutopia:** search with `cgibin/make-table.cgi?searchingfor=<q>`. The HTML table is parsed
  for title, composer, license and the `.mid` link. Files come from
  `www.mutopiaproject.org/ftp/...`.
- **BitMidi:** `https://bitmidi.com/api/midi/search?q=<q>`, read as JSON. Files come from the
  result's download URL on `bitmidi.com`. The license is unknown, so the files are loaded on
  demand and never cached beyond the TTL.
- **IMSLP:** search through its API; results open the work page (no file loading).
- Each source module has a parser tested on a small synthetic fixture that mirrors the
  documented shape.

## R16. Deployment

- **Image:**
  - `python:3.12-slim` with uv; copies `src/`, `server/`, `arranger/data/catalog/`,
    `pyproject.toml` and `uv.lock`.
  - Runs `uvicorn server.app:app` as a non-root user with a read-only root filesystem.
  - Built and pushed by GitHub Actions to `ghcr.io/giowgiow/nes-arranger-server:<sha>` and
    `:main`.
- **Homelab** (`deploy/homelab/nes-arranger/`):
  - namespace, Deployment (1 replica, probes on `/health`, requests 50m/128Mi, limits 500m/512Mi),
    Service, NetworkPolicies:
    - ingress only from `traefik-system`;
    - egress DNS plus `0.0.0.0/0` except 10/8, 172.16/12, 192.168/16, 100.64/10 and 169.254/16.
  - `ingress-external.yaml` for `nes-arranger-bh.giow.dev`:
    - external-dns annotations, zone wildcard TLS;
    - crowdsec, redirect, rate-limit and secure-headers middlewares;
    - no OAuth, a documented public-API exception;
    - Gatus annotation on `/health`.
  - A README lists the two shared files to edit in the same commit: the FRP `customDomains` and
    the Pi-hole `local=` line.
