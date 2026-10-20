# Data Model: Song Browser, Song Server and Channel Mixer

## Catalog entry (one per song record, per source file)

| Field | Type | Rule |
|---|---|---|
| `id` | string | Unique within the source; stable across regenerations (MPB: slug + variant; Nottingham: file + X number; PDMX: content hash prefix). |
| `source` | `"examples" \| "mpb" \| "public-domain" \| "nottingham" \| "pdmx"` | The card it belongs to. |
| `t` | string | Title. |
| `c` | string | Composers as written by the source ("" when unknown). |
| `p` | string | Performer or arranger (optional). |
| `u` | string | Page link at the source (optional for examples). |
| `license` | string | `"all-rights-reserved"`, `"public-domain"`, `"GPL-3.0"`, `"CC0"`, `"PDM"`, … |
| `seed` | integer 0..2^32−1 | Sprite seed: first 32 bits of SHA-256(`source:id`). |
| `route` | object | How to open it (below). |
| `facts` | object | Analysis facts (MIDI-derived entries), optional. |
| `error` | string | Present when the song cannot be arranged; then `route` is absent. |

**Route** (exactly one kind):
- `{ "abc": "<repo-relative path>", "tune": <index> }`: an ABC lead sheet in the repository.
- `{ "server": "/songs/mpb/<id>.abc" }`: the song server reduces the source MIDI on demand.

## Analysis facts (MIDI-derived)

| Field | Type | Rule |
|---|---|---|
| `midi` | string | Source file URL (MPB) or dataset path (PDMX). |
| `sha256` | string | Of the exact source bytes; the server refuses a mismatch. |
| `melody_track` | integer | From the ranking port (R13). |
| `bars` | [first, end] | ≤ 64 bars, 0-based, end excluded. |
| `sections` | [[bar, label]] | Default `[[0, "A"]]`. |
| `key`, `tempo_bpm`, `meter`, `n_bars` | string, number, string, integer | From the reduction. |
| `drums` | boolean | The file has a drum track. |
| `overrides` | object | GA overrides (`max_generations`, `stagnation_window`). |

Facts never hold notes.

## Author record (`data/catalog/authors.json`)

`{ "name": str, "qid": str | null, "death_year": int | null, "status": "dead" | "alive" |
"unknown", "source": url, "checked": "YYYY-MM-DD" }`. A song is public domain only when all its
authors have `death_year ≤ 1955`.

## Search result (server and The Session)

`{ source, id, title, composer, license, format: "midi" | "abc" | "link", page, open }`, where
`open` is the URL the app fetches (server `/files/...`, The Session tune JSON) or the page to open
for `link`.

## Mix

`{ P1: dB, P2: dB, TR: dB, NO: dB, muted: { P1: bool, … } }`; dB in [−60, +6], −60 means silent.
Stored in localStorage `nes-arranger-mix` with a `version` field; an unreadable value falls back
to the defaults (R1).

## Browser state (song-browser.js)

`{ view: "cards" | "songs", card: source, query: string, index: number, open: boolean }`.
Transitions: cards ⇄ songs (Enter / Escape); songs → details (Enter) → Arrange hands the song to
the input panel and keeps the state; a dropped or chosen file sets the insert-disc slot.
