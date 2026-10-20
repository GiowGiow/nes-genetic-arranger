# Research: Song Browser, Song Server and Channel Mixer

Sources were checked on 2026-10-20. The approved design is in the plan. Decisions are below.

## R1. Default channel levels (measured)

- **Decision:** the defaults are per-channel offsets in dB on top of the chip's own mixer gains
  (`CHANNEL_GAINS`).
  - They are chosen so that, averaged over the 8 example arrangements (seed 1, default
    settings), the gated loudness of the TR stem and of the NO stem is 3 dB below the P1 stem.
  - P2 is set 1 dB below P1, because it is the harmony.
  - The measurement script is a test, `arranger/tests/mixer-defaults.test.js`: it recomputes the
    gaps and checks that the defaults keep each gap within 4 dB (SC-001).
- **Measured** (filled in by task T012): see the table at the end of this section.
- **Rationale:** the student hears bass and drums as too quiet. The chip gains are the linear
  NES mixer approximation (TR 1.13, NO 0.66 relative to a pulse), but a low triangle carries
  little energy where the ear is most sensitive. Short drum hits have a low RMS. A measured
  offset fixes the balance for every pack, because packs map to the same four stems.
- **Alternatives considered:**
  - Changing `CHANNEL_GAINS` would break the chip parity with the CLI and the Korobeiniki pin.
  - A K-weighted LUFS meter is more exact, but needs a filter not used anywhere else. The gated
    RMS already in `loudness.js` is enough for a default.

| Stem | Gap to P1 before (dB) | Default offset (dB) | Gap after (dB) |
|---|---|---|---|
| P2 | (T012) | (T012) | (T012) |
| TR | (T012) | (T012) | (T012) |
| NO | (T012) | (T012) | (T012) |

## R2. Stems and live gain changes

- **Decision:**
  - `renderChipStems` returns the four channels before normalization, on one scale.
  - `renderChip` is the stems summed with `CHANNEL_GAINS` and scaled to a -3 dBFS peak, with
    the same float operations in the same order, so its output stays byte-identical (a test
    compares it with the pinned SHA).
  - The player creates one `AudioBufferSourceNode` per stem. Each goes through a `GainNode`
    into an arrangement bus, then a `DynamicsCompressorNode` used as a limiter (threshold
    -1 dB, knee 0, ratio 20, attack 3 ms, release 100 ms), then the destination.
  - Levels ramp over 10 ms, like the A/B switch.
- **Loudness matching** against the original is computed once per render, on the mix at the
  default levels. The resulting factor scales the bus, so the visitor's changes are relative to
  a matched mix.
- **Rationale:** gains on stems change the mix instantly without re-rendering. The limiter
  handles boosts up to +6 dB on all channels.
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

## R6. 3D scene

- **Decision:**
  - three.js 0.186.1 `three.module.min.js` is vendored (MIT) and imported through an import
    map, so there is no build step.
  - **Memory-card screen:** a row of cards, each a thin box with the source's sprite emblem and
    color.
  - **Save icons:** each song is a low-poly vinyl (a 24-segment cylinder for the disc, a
    16-segment cylinder for the label) with its sprite texture. Sprites are drawn into a
    256×256 canvas atlas (256 sprites) with nearest filtering.
  - **Background:**
    - a deep blue gradient sky dome, plus exponential fog;
    - 60 additive light particles;
    - 5 tall translucent "pillars" that pulse slowly, as in the PS2 BIOS;
    - selection glow from an additive halo sprite, with no post-processing pass, to keep the
      vendored code to one file.
  - **Resolution:** the canvas renders at 0.5× device pixels with `image-rendering: pixelated`
    for the low-res look. Rendering pauses while the tab is hidden.
  - **Scale:** only the 40 songs nearest the selection are meshes; scrolling recycles them.
- **Alternatives considered:**
  - The PS1 jitter shader was the student's first idea, but the PS2 memory-card look replaced
    it.
  - Post-processing bloom would need the three.js addons.

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
