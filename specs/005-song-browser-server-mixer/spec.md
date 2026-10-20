# Feature Specification: Song Browser, Song Server and Channel Mixer

**Feature Branch**: `main` (the student commits to `main` directly in this repository)

**Created**: 2026-10-20

**Status**: In progress (design approved in previews, 2026-10-20)

**Input**: User description (translated from Portuguese). The student asked for the following
changes.
- Replace "your file, examples and MPB catalog" with a real catalog: 3D, with vinyl records,
  in the style of the PS2 memory card screen, and a sprite icon for each song.
- Keep search and the upload of a .mid file.
- Search other MIDI sites and indexers, so their songs can be brought in too, without the
  download-and-drop step. A machine of ours can do this.
- Have much more of the catalog available.
- Control the volume of P1, P2, bass and drums while playing. P1 and P2 are much louder than
  bass and drums, and the mix sounds unbalanced.
- When previewing a track to pick the melody, skip to where the instrument plays.

The design decisions were approved on 2026-10-20 and are recorded in the plan. Under
constitution 2.0.0, copyrighted songs load on demand and only public-domain or openly licensed
ABC is committed.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Balance the channels while listening (Priority: P1)

After a run, the visitor hears the arrangement with bass and drums at a level that sits close to
the two pulses. Four controls (P1, P2, bass, drums) change each channel's level while the music
plays, in every sound pack. The levels are remembered next time. The visitor can download what
they hear as a WAV file.

**Independent Test**:
1. Arrange Korobeiniki and play it with the default levels: the triangle bass and the drums are
   clearly audible.
2. Drag the drums control down to mute: the drums disappear at once, and playback does not
   restart or jump.
3. Switch to the Game Boy pack: the levels still apply.
4. Download the WAV: it sounds like the current pack and mix.

**Acceptance Scenarios**:

1. **Given** default levels, **When** any example is arranged, **Then** the bass and the
   drums are lifted over the chip's balance: TR by 4 dB and NO by 10 dB. Measured as gated RMS,
   TR sits 2 dB under to 7 dB over the melody, the drums gain at least 8 dB, and the student
   hears the bass and the drums clearly.
2. **Given** a playing arrangement, **When** a level changes, **Then** the change is heard within
   a fraction of a second, and the position and the play state are kept.
3. **Given** any of the five packs, **Then** the four controls act on the matching parts of that
   pack: melody, harmony, bass, drums.
4. **Given** a level raised above 0 dB, **Then** the output does not clip.
5. **Given** levels set once, **When** the page reloads, **Then** the same levels apply, if the
   browser keeps local storage. A Reset control returns to the defaults.
6. **Given** a finished run, **Then** a "WAV" download holds the arrangement with the current
   pack and levels. The MIDI download is unchanged.

---

### User Story 2 - Preview a track from where it plays (Priority: P1)

When a MIDI song is loaded, the visitor previews tracks to choose the melody. The preview starts
at the track's first note, not at the start of the excerpt, and skips long rests.

**Independent Test**: load a MIDI song whose melody enters after a long intro and press the
preview button of the melody track. The first note sounds within a second.

**Acceptance Scenarios**:

1. **Given** a track whose first note in the excerpt falls at bar N, **When** it is previewed,
   **Then** playback starts at bar N.
2. **Given** a track with a silent stretch of 2 or more bars, **Then** the preview jumps over
   the stretch. It keeps gathering playing bars until 8 bars have been heard or the song ends.
3. **Given** a track with no notes inside the excerpt, **Then** the preview plays from the bar
   where the track first plays in the whole song, and the hint says which bar that is.
4. **Given** a track with no notes at all, **Then** the preview says so and plays nothing.

---

### User Story 3 - Leaf through one catalog of vinyl records (Priority: P1)

The Song tab shows the catalog as pages of floating vinyl records. The look takes after the PS2
memory card screen (floating icons that bob, a selected icon that lifts, spins and glows), but
no PS2 wording or memory cards appear.
- **One catalog:** the 8 examples come first, then every other song in alphabetical order. The
  catalog has no separate tabs per source, and the page never names the sites the songs come
  from. Credits and licenses are in the README and the article, linked from How it works.
- **Pages:** 15 records per page on a wide screen, 9 on a phone. ‹ and › buttons, the arrow
  keys at the edges of a page, and PageUp and PageDown turn the pages.
- **Each record:** the label is a pixel-art sprite drawn from the song's data, so the same song
  always gets the same sprite. Label colors come from the four channel colors.
- **The selected song:** a panel next to the records shows title, composer, key, tempo, meter
  and bars, as labeled values. Its actions are Arrange and Preview. It has no link to the
  source page.
- **Your own file:** an "Open MIDI or ABC" button and the search box are always visible in the
  Song card's header. Dropping a file anywhere on the card still loads it.
- **Integration:** the 3D area has no box of its own. The records float over the Song card's
  glass, and the card's soft glow in the channel colors covers the whole card.

**Independent Test**:
1. Open the app: the first record is Korobeiniki.
2. Choose Arrange: the song loads and the GA can start, as it does today.
3. Turn to page 2 with ›, then come back with PageUp.
4. Do the same with a screen reader: the songs on the page are announced as a list.
5. Do the same with WebGL turned off: a 2D grid of the same sprites works the same way.

**Acceptance Scenarios**:

1. **Given** the Song tab, **Then** the search box and the "Open MIDI or ABC" button are
   visible. Dropping a .mid, .midi, .kar, .abc or .txt file anywhere on the Song card loads it.
2. **Given** the catalog, **Then** keyboard, pointer and touch all work:
   - arrows, Home/End, PageUp/PageDown and Enter move the selection and open a song;
   - tap and click select a record.
3. **Given** a song, **Then** its sprite is identical on every visit and every device.
4. **Given** a song's Arrange action, **Then** the song reaches the existing reading flow:
   - an ABC song opens like an example does today;
   - a MIDI song opens the track table and the bar range.
5. **Given** reduced motion is requested, **Then** records do not bob or spin.
6. **Given** a phone 375 px wide, **Then** the catalog fits without horizontal scrolling and
   stays usable by touch.
7. **Given** the whole catalog (about 7,000 songs), **Then** turning pages stays smooth: only
   the current page's records exist in the scene.
8. **Given** any text on the page, **Then** no pill or chip packs several facts separated by
   "·". Facts appear as labeled values. The channel legend in the header is a small grid
   (channel, wave, role).

---

### User Story 4 - Open any catalog song in one click (Priority: P1)

Every song of the MPB catalog (3,671 songs, 3,760 MIDI files) opens like an example:
- in one click;
- as an ABC lead sheet;
- with the melody track, bar range and sections already chosen;
- with no download and no drop.

The app gets the lead sheet from the song server. The server reads the MIDI from the catalog
site at that moment and keeps no permanent copy.

**Independent Test**: with the server running, open the MPB card, pick a song and choose
Arrange. The lead sheet summary appears without any track choice, and it equals the lead sheet
the command line reduces from the same MIDI file with the recorded options.

**Acceptance Scenarios**:

1. **Given** an MPB song, **When** it is opened, **Then** the app shows its lead sheet in under
   5 s on a home connection, and credits the catalog site with a link to the song page.
2. **Given** the MIDI file on the catalog site changed since the analysis (another SHA-256),
   **Then** the server refuses to reduce it, and the app explains that the song changed at its
   source. The other songs keep working.
3. **Given** the server does not answer, **Then** the app says the song server is offline.
   Local sources, uploads, arranging and playback keep working.
4. **Given** a song in the public domain, **Then** it opens from the repository itself, with no
   server involved.

---

### User Story 5 - Search across sources and external sites (Priority: P2)

The visitor types in the search box. Results come from every local source at once: Examples,
MPB, Public domain and Open collections. Results from external sites arrive in the Search card
as they come in, each marked with its site and license. A result can be opened in one click; a
site that only allows links opens its page instead.

**Independent Test**: search for "polka". Local matches appear at once, and external results
follow within a few seconds. Open a The Session tune: it loads as ABC. Open a BitMidi or Mutopia
result: it loads as MIDI with the track table. Open an IMSLP result: its page opens in a new tab.

**Acceptance Scenarios**:

1. **Given** a query of at least 2 characters, **Then** local results appear while typing,
   ranked as today (title prefix, title, then composer or performer).
2. **Given** the server is running, **Then** external results from the allow-listed sites arrive
   in the Search card, each with its source, license and page link.
3. **Given** The Session, **Then** the browser itself searches it and loads its tunes. The song
   server is not involved.
4. **Given** the server is offline, **Then** local and The Session results still appear, and the
   app says that the other external sites are unavailable.
5. **Given** a song on the server's takedown denylist, **Then** it is neither listed nor served.

---

### User Story 6 - More songs in the repository (Priority: P2)

The repository gains ABC lead sheets that may be redistributed:
- MPB catalog songs whose every author died in 1955 or earlier;
- the Nottingham collection (GPL-3.0);
- a filtered subset of the PDMX dataset, whose composers died in 1955 or earlier or whose
  uploader composed the work.

Each collection keeps its license file, and the app shows its attribution.

**Independent Test**: run the documented commands. They regenerate the committed catalog files
and ABC folders byte for byte from the recorded inputs.

**Acceptance Scenarios**:

1. **Given** an author whose death year is unknown or ambiguous, **Then** that author's songs are
   not treated as public domain.
2. **Given** a committed ABC file, **Then** its header records its source, license and the
   command that wrote it.
3. **Given** the committed catalog, **Then** it holds no notes of any song that is not public
   domain or openly licensed. Only analysis facts are kept.

### User Story 7 - One screen per tab, and How it works (Priority: P2)

The sections Song, Evolution, Result and How it works become tabs, and only the chosen tab's
screen shows:
- The Run card sits in the Song tab, next to the catalog.
- Pressing Arrange moves to Evolution by itself; when the run ends, the app moves to Result.
- "How it works" replaces About. It explains the method step by step, for a reader who does
  not know genetic algorithms, with one small picture per step. Where possible, the pictures
  use the loaded song:
  1. song to lead sheet;
  2. genome;
  3. fitness;
  4. evolution;
  5. realization;
  6. sound.

  It ends with links to the repository and the article, where sources and licenses are
  credited.

**Independent Test**: load Korobeiniki and press Arrange: the Evolution tab opens. At the end of
the run the Result tab opens. Open How it works: each of the six steps is shown, with Korobeiniki
as the running example.

**Acceptance Scenarios**:

1. **Given** the tabs, **Then** they are keyboard accessible (`role=tablist`, arrows, Home/End),
   and the chosen tab is kept in the page URL (`#song`, `#evolution`, `#result`, `#how`), so a
   reload or a link opens it.
2. **Given** a run starts, **Then** the Evolution tab opens. **Given** it ends, **Then** the
   Result tab opens. The visitor can switch tabs at any time without stopping the run.
3. **Given** How it works, **Then** each step has a title, a short explanation in plain words and
   one picture. When a song is loaded, the pictures use it; otherwise they use Korobeiniki.

### Edge Cases

- **Several MIDI files for one MPB song** (84 songs have more than one link): each file is its
  own record, labeled with its variant.
- **A catalog MIDI that the reader cannot reduce** (no melodic track, broken file): the record is
  listed, marked "cannot be arranged", and has no Arrange action.
- **An external file over the size cap, or not MIDI/ABC**: the server refuses it, and the app
  says why.
- **The visitor drops a file while a card is open**: the file loads as today, and the browser
  shows it as the inserted disc.
- **The browser has no WebGL, or the GPU context is lost**: the 2D grid replaces the 3D view
  without losing the selection.
- **Levels all muted**: the arrangement is silent, and the WAV download is disabled with a note.
- **A preview track whose notes all lie beyond the song's last bar range**: covered by story 2,
  scenario 3.

## Requirements *(mandatory)*

### Channel mixer

- **FR-001**: The app MUST offer four level controls (P1, P2, bass, drums) for the arrangement,
  from muted up to +12 dB, each with mute and a shared Reset. The controls apply to every sound
  pack.
- **FR-002**: A level change MUST apply during playback without restarting it or moving its
  position, and the output MUST NOT clip.
- **FR-003**: The default levels MUST lift the bass and the drums against the pulses:
  P1 0 dB, P2 -1 dB, TR +4 dB and NO +10 dB over the chip's own balance (research R1). The gated
  RMS measured on the 8 examples is recorded in the plan's research. The student confirms the
  balance by ear.
- **FR-004**: The app SHOULD remember the levels in local storage, and work without it.
- **FR-005**: The app MUST offer a WAV download of the arrangement with the current pack and
  levels, peaking at no more than -3 dBFS. The MIDI, settings and ABC downloads MUST NOT change.
- **FR-006**: With all levels at 0 dB relative to the chip's own gains, the NES chip render MUST
  equal today's render sample for sample.

### Track preview

- **FR-007**: A track preview MUST start at the bar of the track's first note in the excerpt. It
  skips silent stretches of 2 or more bars until 8 playing bars are gathered or the song ends.
- **FR-008**: When the track has no notes in the excerpt, the preview MUST play from the track's
  first bar in the whole song and name that bar. A track with no notes MUST say so.

### Song catalog

- **FR-009**: The Song card MUST replace its three tabs with the paged vinyl catalog of story 3,
  with the search box and the "Open MIDI or ABC" button always visible.
- **FR-010**: Each song MUST have a deterministic pixel-art sprite derived from its catalog data.
- **FR-011**: The catalog MUST be usable by keyboard, pointer and touch. A list mirrors the
  current page for assistive technology.
- **FR-012**: The catalog MUST honor reduced motion and fall back to a 2D grid without WebGL.
- **FR-013**: Opening a song MUST hand it to the existing reading flow, with no change to how
  lead sheets are read or arranged.
- **FR-014**: The page MUST stay responsive with the whole catalog. Only the examples load at
  first paint; the rest of the catalog loads in the background or when a page or a search needs
  it.
- **FR-014a**: The interface MUST NOT name the source sites of catalog songs. Credits and
  licenses MUST be reachable from How it works through a link to the README.

### Song server and loading

- **FR-015**: Catalog songs that are not in the repository MUST load through the song server,
  which:
  1. fetches the MIDI from the catalog URL;
  2. checks its SHA-256 against the committed analysis;
  3. reduces it with the recorded options, using the command line's reader;
  4. returns the ABC lead sheet.
- **FR-016**: The server MUST follow constitution 2.0.0 "Song Server Constraints":
  - allow-listed hosts only;
  - size and time caps;
  - content sniffing;
  - polite per-host spacing with the project User-Agent;
  - per-IP rate limits;
  - CORS restricted to the Pages origin and localhost;
  - no route to private networks;
  - a takedown denylist;
  - only a temporary, size-capped cache;
  - no visitor logs.
- **FR-017**: The server MUST offer search across the allow-listed external sites (Mutopia,
  BitMidi, IMSLP) with normalized results (source, id, title, composer, license, format, page),
  and on-demand loading of the files of the sites that allow it.
- **FR-018**: The app MUST search and load The Session from the browser, never through the
  server.
- **FR-019**: The app MUST work without the server and say when it is offline. Without the
  server (not deployed yet, not answering, or its source down) an MPB song opens the way it did
  before the server: its own page opens, the visitor downloads the MIDI and drops it in, and the
  page says so. Until the server is deployed the published page does not ask it for anything
  (`PRODUCTION_SERVER_LIVE`).

### Catalog data

- **FR-020**: A command MUST compute, from the local study copy of the MPB MIDI files, the
  analysis facts of each file:
  - melody track, bar range and sections;
  - key, tempo, meter and bars;
  - drums;
  - SHA-256;
  - sprite seed.

  It writes them to the committed catalog with no notes.
- **FR-021**: A command MUST resolve each author's death year from a recorded source and commit
  the result. Unknown or ambiguous authors count as not public domain.
- **FR-022**: Commands MUST write the ABC lead sheets of the public-domain MPB songs, the
  Nottingham collection and the filtered PDMX subset, each with provenance headers and license
  files.
- **FR-023**: The catalog MUST be split per source and credit each source.

### Tabs and How it works

- **FR-025**: The sections MUST be tabs showing one screen at a time: Song (catalog + Run),
  Evolution, Result and How it works. The tab is kept in the URL hash.
- **FR-026**: Starting a run MUST open Evolution, and finishing it MUST open Result.
- **FR-027**: How it works MUST explain the six steps with one picture each, using the loaded
  song when there is one.

### Deployment

- **FR-024**: The repository MUST hold:
  - the server's container definition;
  - a workflow that publishes its image;
  - the manifests and instructions to deploy it in the student's homelab at
    `nes-arranger-bh.giow.dev`.

  Pushing to the homelab repository requires the student's explicit approval at that time.

### Key Entities

- **Catalog entry**: one song record in one source.
  - Identity: id, source, title, composers, performer, page link, license, sprite seed.
  - Loading route: a committed ABC path, a server route, a browser route (The Session) or a link
    out.
  - For MPB entries, the analysis facts.
- **Analysis facts**: measured facts about a MIDI file:
  - melody track, bar range, sections;
  - key, tempo, meter, bars;
  - drums, SHA-256.

  They contain no notes.
- **Author record**: a name, its matched identifier at the recorded source, the death year and
  the source link.
- **Search result**: source, id, title, composer, license, format and page, plus how to open it.
- **Mix**: four levels in dB, with a mute flag each.

## Success Criteria *(mandatory)*

- **SC-001**: With default levels on the 8 examples, the bass sits between 2 dB under and
  7 dB over the melody (gated RMS), the drums are lifted by at least 8 dB over the chip's
  balance, and no default mix clips. The before and after gaps are recorded.
- **SC-002**: A level change is audible within 0.1 s while playing, with 0 restarts or position
  jumps.
- **SC-003**: For a track that enters after 16 bars of rest, the preview's first note sounds
  within 1 s of pressing preview.
- **SC-004**: All 3,760 MPB files have analysis facts. At least 95% of them open as a lead sheet
  through the server, in under 5 s each on a home connection.
- **SC-005**: The repository gains at least 1,000 redistributable ABC lead sheets, each with
  provenance and license.
- **SC-006**: The browser opens a song with 4 key presses or fewer from the first screen, and
  keeps at least 30 frames per second on a mid-range phone while moving through a card of 3,000
  songs.
- **SC-007**: With the server stopped, every local feature still works, and 100% of server-routed
  actions explain that the server is offline.
- **SC-008**: The 10 samples rerun to the same plans, fitness and MIDI bytes, and the parity
  fixtures do not change.

## Assumptions

- The local study copy of the MPB MIDI files (outside the repository) is available to the student
  for computing the analysis facts. It is never committed.
- The song server runs in the student's homelab (single-node k3s with ArgoCD). It is reached
  publicly through the existing FRP relay on the Oracle VM. Deploying there follows that
  repository's own rules.
- Allow-listed sites can change or block automated access. The app treats each source as
  optional, and the README records each site's terms as checked on 2026-10-20.
- Public domain uses the life + 70 years rule of Lei 9.610/98 art. 41. In 2026 that means every
  author died in 1955 or earlier. The MIDI sequence's own arrangement is dropped by the
  reduction, which keeps only melody, chords and part labels.
- Sprites, the browser's look and the mixer are playback and presentation features of the app.
  They need no Python parity. The reduction used by the server is the Python reference code
  itself.
- The Session's data license forbids processing by language models. AI agents working on the
  repository never read its tune data, and tests use synthetic data shaped like its API.
