// @ts-check
/**
 * Page wiring: input, settings, the GA worker, the evolution display, playback and downloads.
 *
 * A run goes through the states of data-model.md ("Run state"):
 *
 *   idle → evolving → realized → ready (or failed when the arrangement breaks an NES rule)
 *
 * The genetic algorithm runs in a module worker (`../worker.js`), so the page stays responsive
 * (FR-015). The page sends `run` and `stop` messages and draws every `progress` message
 * (contracts/worker-protocol.md). When the worker is `done`, the page realizes the best plan into
 * notes, checks the NES rules, renders the chip sound and offers the downloads. Dropping a new
 * file during a run stops it and discards it.
 *
 * What the Result panel holds is kept small and true (`result-sound.js`): the player holds the
 * sound of the song on screen only, and only the run on screen keeps its rendered audio.
 */

import { assemble, findViolations } from "../core/arrangement.js";
import { writeLeadSheetAbc } from "../core/abc-writer.js";
import { totalBeats } from "../core/meter.js";
import { arrangementToMidi } from "../core/midi-export.js";
import { configRecord, defaultSettings, runId, validateSettings } from "../core/settings.js";
import { matchLoudness } from "../audio/loudness.js";
import { leadSheetVoices, midiExcerptVoices, renderVoices, trackPreview } from "../audio/plain-synth.js";
import { createPlayer } from "../audio/player.js";
import { SOUND_PACKS } from "../audio/sound-packs.js";
import { defaultLevels, mixStems, readLevels, readVolume, storeLevels, storeVolume } from "../audio/mixer.js";
import { encodeWav } from "../audio/wav.js";
import { createChannelView } from "./channel-view.js";
import { createDownloads } from "./downloads.js";
import { downloadStartedMessage, looksLikeDownload, openDownloadedFile } from "./downloaded-file.js";
import { createEvolutionView } from "./evolution-view.js";
import { createInputPanel, loadAbcjs } from "./input-panel.js";
import { howItWorksSteps, renderHowItWorks } from "./how-it-works.js";
import { readLeadSheetAbc } from "../core/abc-reader.js";
import { createMixerPanel } from "./mixer-panel.js";
import { createPacer, drawingBudget } from "./pacing.js";
import { createPlanGrid } from "./plan-grid.js";
import { addRun, runShown } from "./run-list.js";
import { createResultSound } from "./result-sound.js";
import { createVolumeSlider } from "./volume-slider.js";
import { renderScores } from "./scores-table.js";
import { changedSettings, valueAt } from "./settings-form.js";
import { createRunsView } from "./runs.js";
import { createSettingsPanel, settingLabel, settingValueText } from "./settings-panel.js";
import { setUpPageTabs } from "./tabs.js";
import { createSongShelf } from "./song-shelf.js";
import { PAGE_MESSAGE, PAGE_PREVIEW_MESSAGE, displayTitle, externalEntry, isLoadedSong, loadCatalog, localEntry, openEntry } from "../core/sources.js";
import { searchResults as sessionSearchResults, searchUrl as sessionSearchUrl } from "../core/thesession.js";

/** @typedef {import("./input-panel.js").LoadedInput} LoadedInput */
/** @typedef {import("../core/settings.js").Settings} Settings */

const $ = (/** @type {string} */ selector) =>
  /** @type {HTMLElement} */ (document.querySelector(selector));

const [version, defaultConfig] = await Promise.all([
  fetchJson("version.json").catch(() => ({ commit: "dev" })),
  fetchJson("../configs/default.json"),
]);
$("#app-version").textContent = version.commit === "dev" ? "dev" : version.commit.slice(0, 7);

// Offline use after the first visit (FR-035); the page works without it.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

/** Where the page remembers the chosen sound pack (one viewer's convenience, spec 004). */
const SOUND_PACK_KEY = "nes-arranger-sound-pack";

/** The app state: everything the panels show comes from here. */
const state = {
  /** @type {Settings} */
  settings: defaultSettings(defaultConfig),
  /** @type {LoadedInput | null} */
  input: null,
  /** @type {"watch" | "full"} */
  pace: "full",
  /** @type {string} the sound pack the arrangement plays with (spec 004) */
  soundPack: storedSoundPack(),
  /** @type {"idle" | "evolving" | "realized" | "ready" | "failed"} */
  phase: "idle",
  /** @type {string | null} */
  currentRunId: null,
  /** @type {any[]} */
  runs: [],
  /** @type {any[]} generations of the current run, for the run list */
  log: [],
  /** @type {Record<string, number>} settings an example set, undone when another input loads */
  appliedOverrides: {},
};
const defaults = defaultSettings(defaultConfig);

// --- Panels ---------------------------------------------------------------------------------

/** What a phone cannot afford while it plays music (see pacing.js): a touch screen gets the smaller budget. */
const budget = drawingBudget(globalThis.matchMedia?.("(pointer: coarse)").matches ?? false);

const pageTabs = setUpPageTabs($("[data-page-tabs]"), {
  viewNav: $("[data-view-tabs]"),
  // The figures are drawn only when the tab is open; a timeout lets the page finish wiring first.
  onChange: (id) => {
    placeRunStrip(id);
    if (id === "how") setTimeout(drawHowItWorks);
  },
});

/**
 * The run controls (song, seed, pace, Arrange, Stop, Settings) live in the Song card and on top
 * of the Evolution tab, so a setting can be changed and the next run started where the evolution
 * and the result are. It is one element, moved to the slot of the tab that is open.
 *
 * @param {string} tab the tab id
 */
function placeRunStrip(tab) {
  const slot = document.querySelector(`[data-run-slot="${tab === "evolution" ? "evolution" : "song"}"]`);
  const strip = document.getElementById("run");
  if (slot && strip && strip.parentElement !== slot && tab !== "how") slot.append(strip);
}
const inputPanel = createInputPanel(
  { root: $("#song"), file: $("[data-file-target]"), examples: $("[data-examples-target]"), details: $("[data-song-details]") },
  {
  examples: [],
  previewTrack: (index) => previewTrack(index),
  onUnreadable() {
    // The options now chosen cannot be read: nothing is left to arrange until they are fixed.
    if (state.phase === "evolving") stopRun(true);
    state.input = null;
    $("[data-run-song]").textContent = "These options cannot be read; the message is under the song.";
    updateRunButtons();
  },
  useTempo(bpm) {
    state.settings.tempo_bpm = bpm;
    settingsPanel.show(state.settings, state.phase === "evolving");
    inputPanel.reread();
  },
  readOptions: () => ({
    phraseLength: state.settings.phrase_length,
    roleMap: state.settings.role_map,
    tempoOverride: state.settings.tempo_bpm,
  }),
  onFileDropped: (name) => claimDownload(name),
  onLoaded(loaded) {
    // The arrangement on screen belongs to the reading before this one: its sound, scores and
    // downloads go, so Play and the A/B toggle can never play or show another song's.
    clearResult();
    resultSound.forget();
    if (state.phase === "evolving") stopRun(true);
    state.input = loaded;
    // An example's own limits (the MIDI songs' 4000/400) last only while it is the input.
    for (const key of Object.keys(state.appliedOverrides)) {
      if (state.settings[key] === state.appliedOverrides[key]) state.settings[key] = defaults[key];
    }
    state.appliedOverrides = { ...loaded.overrides };
    Object.assign(state.settings, loaded.overrides);
    state.settings.midi = { ...state.settings.midi, ...loaded.midi };
    settingsPanel.show(state.settings, false);
    // With no tempo override the lead sheet plays at the file's tempo: the field's placeholder.
    if (state.settings.tempo_bpm === null) settingsPanel.setFileTempo(loaded.leadSheet.tempoBpm);
    planGrid.setBars(loaded.leadSheet.bars);
    $("[data-run-song]").textContent =
      `${loaded.leadSheet.title || loaded.input.name} (${loaded.leadSheet.bars.length} bars)`;
    updateRunButtons();
    if (pageTabs.current() === "how") drawHowItWorks();
    rememberOwnSong(loaded);
  },
  },
);

// --- Song catalog: one shelf of records, examples first (spec 005, story 3) ------------------

const shelf = createSongShelf($("[data-shelf]"), {
  entries: [],
  onSearch: (query) => {
    clearTimeout(searchTimer);
    if (query.trim().length >= 2) searchTimer = setTimeout(() => searchElsewhere(query), 450);
  },
  onArrange: async (entry) => {
    if (await openCatalogEntry(entry)) startRun();
  },
  onPreview: async (entry) => {
    if (await openCatalogEntry(entry, { openPages: false })) playIntro();
  },
  onDownload: (entry) => startDownload(entry),
  onOpenDownloaded: (entry) => openDownloaded(entry),
});
/** @type {any[]} the catalog's songs, as far as they have been read */
let catalogEntries = [];
/** @type {any[]} the visitor's own files, as records, newest first */
const ownEntries = [];
/** @type {Map<string, {name: string, bytes: Uint8Array}>} the files behind those records */
const ownFiles = new Map();

function showSongs() {
  shelf.setEntries([...ownEntries, ...catalogEntries]);
}

/**
 * A file the visitor opened (dropped, chosen or from a link) gets its own record at the head of
 * the shelf, selected, so it can be found and arranged again later in the visit.
 *
 * @param {any} loaded the input panel's loaded song
 */
function rememberOwnSong(loaded) {
  const { input } = loaded;
  if (input.catalogEntry) return; // a shelf song, or one matched to a shelf song
  const entry = localEntry({ name: input.name, sha256: input.sha256, leadSheet: loaded.leadSheet });
  const known = ownEntries.findIndex((own) => own.id === entry.id);
  if (known < 0) {
    ownEntries.unshift(entry);
    ownFiles.set(entry.id, { name: input.name, bytes: input.bytes });
  }
  shelf.setQuery("");
  showSongs();
  shelf.select(known < 0 ? 0 : known);
}

loadCatalog(fetch, (entries) => {
  catalogEntries = entries;
  showSongs();
})
  .then(({ entries }) => {
    if (entries.length === 0) throw new Error("empty catalog");
  })
  .catch(() =>
    songStatus("The catalog could not be loaded. You can still open your own MIDI or ABC file.", true),
  );
$("[data-open-file]").addEventListener("click", () => $("[data-file]").click());

/** @type {ReturnType<typeof setTimeout> | undefined} */
let searchTimer;
const searchBox = shelf.searchBox;

/**
 * Search The Session (from the browser, its API allows it) and add what it finds after the
 * catalog's matches, if the query is still the same.
 *
 * @param {string} query
 */
async function searchElsewhere(query) {
  /** @type {Array<import("../core/sources.js").SearchResult>} an unreachable site adds nothing */
  let found = [];
  try {
    const response = await fetch(sessionSearchUrl(query));
    if (response.ok) found = sessionSearchResults(await response.json());
  } catch {}
  if (searchBox.value === query) shelf.setExternal(found.map(externalEntry));
}

/**
 * Download a file from another site: the browser saves it, and the page cannot read it, so the
 * visitor drops it in afterwards.
 *
 * @param {string} url
 * @param {string} name
 */
function downloadFrom(url, name) {
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  link.target = "_blank";
  document.body.append(link);
  link.click();
  link.remove();
}

/**
 * The song whose downloaded file the visitor is about to choose through the hidden file input
 * (browsers without the native picker). The input panel asks `claimDownload` who a chosen file is.
 *
 * @type {{entry: any, name: string} | null}
 */
let awaitedDownload = null;

/**
 * The "Download MIDI" button of a record: save the song's MIDI file under `<Title>.mid`. The
 * page cannot fetch it (its site sends no CORS header), so the browser saves it and the visitor
 * gives it back with "Open downloaded file".
 *
 * @param {any} entry
 */
async function startDownload(entry) {
  try {
    const song = await openEntry(entry, { fetchFn: fetch });
    if (song.kind !== "link") return;
    downloadFrom(song.url, song.name);
    songStatus(downloadStartedMessage(song.name, window));
  } catch (error) {
    songStatus(/** @type {Error} */ (error).message ?? String(error), true);
  }
}

/**
 * The "Open downloaded file" button of a record: a file dialog, in the Downloads folder where the
 * browser can. The chosen file opens as the record's song, as if it were dropped on the page. The
 * page cannot read the folder itself, so the visitor still confirms the file in the dialog.
 *
 * @param {any} entry
 */
async function openDownloaded(entry) {
  try {
    // Opening a link entry reads nothing from the network; it only gives the file name.
    const song = await openEntry(entry, { fetchFn: fetch });
    awaitedDownload = { entry, name: song.name };
    const how = await openDownloadedFile({
      win: window,
      fileInput: /** @type {HTMLInputElement} */ ($("[data-file]")),
      onFile: (file) => inputPanel.readFile(file, entry.facts?.overrides ?? {}, entry),
    });
    // Only the file input still waits for a file (its change event asks claimDownload).
    if (how !== "input") awaitedDownload = null;
  } catch (error) {
    songStatus(/** @type {Error} */ (error).message ?? String(error), true);
  }
}

/**
 * Tell the input panel which record a chosen file is, when the visitor opened the dialog for a
 * downloaded song and chose a file of its name.
 *
 * @param {string} name the chosen file's name
 * @returns {any} the record, or null when the file is the visitor's own
 */
function claimDownload(name) {
  const waiting = awaitedDownload;
  awaitedDownload = null;
  return waiting && looksLikeDownload(name, waiting.name) ? waiting.entry : null;
}

/**
 * Load a catalog song into the input panel, as if its file were dropped.
 *
 * @param {any} entry
 * @param {{openPages?: boolean}} [options] `openPages: false` (Preview) never opens a page
 * @returns {Promise<boolean>} true when the song was read
 */
async function openCatalogEntry(entry, { openPages = true } = {}) {
  // The song is already read, and the visitor may have chosen its melody track and bars: reading
  // it again would put the likeliest track back. A run in progress is cancelled, as a new song does.
  if (isLoadedSong(entry, inputPanel.current()?.input ?? null)) {
    if (state.phase === "evolving") stopRun(true);
    return true;
  }
  const own = ownFiles.get(entry.id);
  if (entry.route?.local && own) {
    const before = inputPanel.current();
    await inputPanel.readFile(new File([own.bytes], own.name), {}, entry);
    return inputPanel.current() !== before && inputPanel.current() !== null;
  }
  songStatus(`Loading ${displayTitle(entry.t)}…`);
  try {
    const abcjs = entry.route?.thesession !== undefined ? await loadAbcjs() : undefined;
    const song = await openEntry(entry, { fetchFn: fetch, abcjs });
    if (song.kind === "link") {
      if (song.byHand) {
        if (openPages) downloadFrom(song.url, song.name);
        songStatus(openPages ? PAGE_MESSAGE : PAGE_PREVIEW_MESSAGE);
      } else {
        if (openPages) window.open(song.url, "_blank", "noopener");
        songStatus("");
      }
      return false;
    }
    const before = inputPanel.current();
    const bytes = song.kind === "abc" ? new TextEncoder().encode(song.text) : song.bytes;
    await inputPanel.readFile(new File([bytes], song.name), entry.facts?.overrides ?? {}, entry);
    return inputPanel.current() !== before && inputPanel.current() !== null;
  } catch (error) {
    songStatus(/** @type {Error} */ (error).message ?? String(error), true);
    return false;
  }
}

/**
 * @param {string} text
 * @param {boolean} [isError]
 */
function songStatus(text, isError = false) {
  const status = $("[data-status]");
  status.textContent = text;
  status.classList.toggle("error", isError);
}

/**
 * Preview on a record: the song's original, in the Result's player, so the position, the channel
 * view and the mixer are there as after a run.
 *
 * - When the run on screen is for this song, its own original plays from the start (the same
 *   sound as the Original button), and the arrangement stays one click away.
 * - Otherwise nothing of an earlier song may stay in the player: the first 8 bars of the loaded
 *   song, as the input sounds, are the only version loaded. The toggle shows the original and the
 *   arrangement button is disabled, because there is no arrangement of this song yet.
 */
function playIntro() {
  const loaded = inputPanel.current();
  if (!loaded) return;
  const context = player.ensureContext();
  previewSource?.stop();
  previewSource = null;
  const shown = runShown(state.runs, state.currentRunId, loaded.leadSheet);
  if (shown && resultSound.replayOriginal()) {
    showWorkbench("result");
    return;
  }
  clearResult();
  const voices = originalVoices(loaded, loaded.leadSheet);
  const beats = Math.min(totalBeats(loaded.leadSheet.bars.slice(0, 8)), totalBeats(loaded.leadSheet.bars));
  const rendered = renderVoices(voices, loaded.leadSheet.tempoBpm, context.sampleRate, beats);
  const samples = matchLoudness(rendered, rendered, context.sampleRate).a;
  const scene = originalScene(clipVoices(voices, beats), loaded.leadSheet.tempoBpm);
  scenes = { arrangement: scene, original: scene };
  resultSound.showIntro(samples, context.sampleRate);
  setResultStatus(
    `Preview of ${loaded.leadSheet.title || loaded.input.name}: its first 8 bars, as the original sounds. Press Arrange to arrange it.`,
  );
  showWorkbench("result");
  player.play();
}

/**
 * Empty the Result panel of the run on screen: nothing of an earlier arrangement (its scores, its
 * downloads, its place in the run list) may stay next to a different song. The runs themselves
 * stay in the list, and clicking one brings it back whole.
 */
function clearResult() {
  state.currentRunId = null;
  scenes = { arrangement: null, original: null };
  shownScene = null;
  channelView.setScene(null);
  downloads.clear();
  $("[data-scores]").replaceChildren();
  runsView.render(state.runs, null);
  setResultStatus("No arrangement yet.");
}

/**
 * Open the Evolution tab on one of its views and bring its run bar to the top of the screen: the
 * evolution when a run starts, the result when a preview plays.
 *
 * @param {"evolution" | "result"} view
 */
function showWorkbench(view) {
  pageTabs.showView(view);
  pageTabs.show("evolution");
  requestAnimationFrame(() => document.getElementById("workbench")?.scrollIntoView({ block: "start" }));
}

/**
 * A run ended, with a result or with the reason it has none: show the Result view, which holds the
 * status line. It is the Result view even if the visitor chose the Evolution view by hand during the
 * run, and even if another tab is open (the Evolution tab then opens on it). When the
 * Evolution tab is open and has been scrolled past its top, bring the result back into sight.
 */
function showRunEnded() {
  pageTabs.showView("result");
  const workbench = document.getElementById("workbench");
  if (pageTabs.current() === "evolution" && workbench && workbench.getBoundingClientRect().top < 0) {
    requestAnimationFrame(() => workbench.scrollIntoView({ block: "start" }));
  }
}

/**
 * The voices with only the notes that start before a point.
 *
 * @param {{melody: any[], others: any[][], drums: any[]}} voices
 * @param {number} beats
 */
function clipVoices(voices, beats) {
  const early = (/** @type {any[]} */ notes) => notes.filter((note) => note.onset < beats);
  return { melody: early(voices.melody), others: voices.others.map(early), drums: early(voices.drums) };
}

const settingsPanel = createSettingsPanel($("#settings"), {
  defaults,
  onChange(settings) {
    // The MIDI options belong to the input panel; the form never edits them.
    state.settings = { ...settings, seed: state.settings.seed, midi: state.settings.midi };
    updateRunButtons();
  },
});
settingsPanel.show(state.settings, false);
const settingsToggle = /** @type {HTMLButtonElement} */ ($("[data-settings-toggle]"));
settingsToggle.addEventListener("click", () => toggleSettings());
$("[data-settings-close]").addEventListener("click", () => toggleSettings(false));
$("#settings").addEventListener("keydown", (event) => {
  if (event.key === "Escape") toggleSettings(false);
});

clearPlaceholder("#evolution");
$("#evolution").insertAdjacentHTML(
  "beforeend",
  `<div class="toolbar evolution-actions">
     <button type="button" class="button" data-stop-evolution disabled>Stop</button>
     <span class="hint">Stop keeps the best plan found so far.</span>
   </div>
   <div data-evolution-view></div>
   <h3 class="subhead">Best plan so far</h3>
   <div data-plan-grid></div>
   <p class="caption">One column per bar. The top row is the chord, named where it changes and
   held until the next tick; a tick without a name is a chord too long for the column. Below it,
   one row per gene: the P2 harmony texture, the TR bass texture, the NO drum pattern and the P1
   melody octave. Brighter cells are busier choices; hover a cell or a chord for its name.</p>`,
);
const evolutionView = createEvolutionView($("[data-evolution-view]"), budget);
const planGrid = createPlanGrid($("[data-plan-grid]"));
const arrangeButton = /** @type {HTMLButtonElement} */ ($("[data-arrange]"));
const stopButton = /** @type {HTMLButtonElement} */ ($("[data-stop]"));
// The Run card scrolls away while the evolution plays, so the Evolution card has its own Stop.
const stopEvolutionButton = /** @type {HTMLButtonElement} */ ($("[data-stop-evolution]"));
stopEvolutionButton.addEventListener("click", () => stopRun(false));
const paceSelect = /** @type {HTMLSelectElement} */ ($("[data-pace]"));
const seedInput = /** @type {HTMLInputElement} */ ($("[data-seed]"));
seedInput.addEventListener("input", () => {
  state.settings.seed = seedInput.value.trim() === "" ? NaN : Number(seedInput.value);
  updateRunButtons();
});

clearPlaceholder("#result");
$("#result").insertAdjacentHTML(
  "beforeend",
  `<div class="transport">
     <button type="button" class="button primary" data-play disabled aria-label="Play">Play</button>
     <span data-volume-slot></span>
     <div class="versions" role="group" aria-label="Version" data-versions hidden>
       <button type="button" class="button" data-version="original">Original</button>
       <button type="button" class="button" data-version="arrangement" aria-pressed="true">NES chip</button>
     </div>
     <label class="sound-pack">Sound
       <select data-sound-pack aria-describedby="sound-pack-hint">
         ${SOUND_PACKS.map((pack) => `<option value="${pack.id}">${pack.name}</option>`).join("")}
       </select></label>
     <input type="range" min="0" max="1" step="0.01" value="0" data-seek aria-label="Position" disabled>
     <span class="mono time" data-time>0:00 / 0:00</span>
     <button type="button" class="button" data-mix-toggle aria-expanded="false" aria-controls="mix">Mix</button>
   </div>
   <p class="hint sound-pack-hint" id="sound-pack-hint" data-sound-pack-hint></p>
   <p class="status" data-result-status role="status" aria-live="polite">No arrangement yet.</p>
   <div data-channel-view></div>
   <p class="caption">Each channel is a line in its color, revealed as it plays: P1 melody (blue),
   P2 harmony (orange), TR bass (gray) and NO drums as ticks at the bottom. Switch to the original
   to see its melody in blue and the other parts as faint dashes. Keys: space plays, A and B
   switch, the arrows move 2 s.</p>
   <div class="scores" data-scores></div>
   <div data-downloads></div>
   <div data-runs></div>`,
);
const player = createPlayer();
const resultSound = createResultSound({ player, runs: () => state.runs });

/** Local storage when the browser allows it; without it the levels last for this visit only. */
const levelStorage = (() => {
  try {
    return localStorage;
  } catch {
    return null;
  }
})();
/** @type {ReturnType<typeof setTimeout> | undefined} */
let levelsTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let volumeTimer;
const savedVolume = readVolume(levelStorage);
const mixerPanel = createMixerPanel($("[data-mixer]"), {
  volume: savedVolume,
  onVolume: (percent) => setVolume(percent, "mixer"),
  // Each sound pack has its own levels, remembered separately (Plain's drums are not the chip's)
  levels: readLevels(levelStorage, state.soundPack),
  defaults: () => defaultLevels(state.soundPack),
  onChange(levels) {
    player.setLevels(levels);
    // The gain ramp above is all the sound needs. Saving the levels waits for the slider to rest:
    // a write to storage on every step of a drag costs main-thread time while the music plays. The
    // WAV is not rebuilt here at all: it is mixed when the visitor clicks its download (see withWav).
    clearTimeout(levelsTimer);
    levelsTimer = setTimeout(() => storeLevels(levelStorage, mixerPanel.get(), state.soundPack), 300);
  },
});
player.setLevels(mixerPanel.get());
player.setVolume(savedVolume);

// The same volume control sits next to Play, so the sound can be turned down without opening the
// drawer. The two sliders show one value, remembered for the next visit once the slider rests.
const compactVolume = createVolumeSlider(document, {
  id: "volume-compact",
  volume: savedVolume,
  compact: true,
  onInput: (percent) => setVolume(percent, "compact"),
});
$("[data-volume-slot]").replaceWith(compactVolume.root);

/**
 * @param {number} percent the master volume, 0 to 100
 * @param {"mixer" | "compact"} from the slider the visitor moved; the other one follows
 */
function setVolume(percent, from) {
  player.setVolume(percent);
  if (from === "mixer") compactVolume.set(percent);
  else mixerPanel.setVolume(percent);
  // As for the levels: save when the slider rests, not on every step of a drag.
  clearTimeout(volumeTimer);
  volumeTimer = setTimeout(() => storeVolume(levelStorage, percent), 300);
}

// The mixer is a drawer that slides in from the left edge: a Mix button opens and closes it, and
// it opens by itself when something starts playing on a wide screen, unless it was closed by hand.
const mixDrawer = $("#mix");
const mixToggle = $("[data-mix-toggle]");
let mixClosedByHand = false;

/**
 * @param {boolean} open
 * @param {boolean} [byHand] the visitor did it, so playing must not open the drawer again
 */
function setMixDrawer(open, byHand = false) {
  mixDrawer.classList.toggle("open", open);
  mixToggle.setAttribute("aria-expanded", String(open));
  if (byHand) mixClosedByHand = !open;
}
mixToggle.addEventListener("click", () => setMixDrawer(!mixDrawer.classList.contains("open"), true));
$("[data-mix-close]").addEventListener("click", () => setMixDrawer(false, true));

/** Show the chosen sound pack's levels: the visitor's own for that pack, or its defaults. */
function showPackLevels() {
  const pack = SOUND_PACKS.find((entry) => entry.id === state.soundPack) ?? SOUND_PACKS[0];
  mixerPanel.set(readLevels(levelStorage, pack.id));
  mixerPanel.setTitle(`Mix for ${pack.name}`);
  player.setLevels(mixerPanel.get());
}
showPackLevels();

/**
 * The download list with the WAV entry made from the run's stems at the mixer's levels *when the
 * visitor clicks it*. Mixing and encoding a three-minute song takes a quarter of a second on a
 * desktop and several times that on a phone, and the file is 17 MB: doing it after every change
 * of the mixer, while the music plays, would stall the page and the playhead. Made on the click,
 * the WAV also always matches the levels at that moment. While every channel is muted the file
 * would be silence, so the click saves nothing. The master volume is a listening control and does
 * not enter the file, which keeps its normalized level.
 *
 * @param {Array<{name: string, label: string, hint: string, blob?: Blob, wav?: boolean}>} files
 * @param {{audio: import("../audio/run-audio.js").RunAudio | null}} run the run on screen: its
 *   stems are read at the click, so the list holds no buffer of its own
 */
function withWav(files, run) {
  return files.map((file) => {
    if (!file.wav) return file;
    return {
      ...file,
      make: () => {
        const levels = mixerPanel.get();
        if (!run.audio || Object.values(levels.muted).every(Boolean)) return null;
        const bytes = encodeWav(mixStems(/** @type {any} */ (run.audio.stems), levels), run.audio.sampleRate);
        return new Blob([bytes], { type: "audio/wav" });
      },
    };
  });
}
const downloads = createDownloads($("[data-downloads]"));
const channelView = createChannelView($("[data-channel-view]"), budget);
/** @type {{arrangement: any, original: any}} */
let scenes = { arrangement: null, original: null };
const runsView = createRunsView($("[data-runs]"), { defaults, onSelect: (id) => showRun(id) });
const playButton = /** @type {HTMLButtonElement} */ ($("[data-play]"));
const seekInput = /** @type {HTMLInputElement} */ ($("[data-seek]"));

// --- Worker ---------------------------------------------------------------------------------

/** @type {Uint8Array | null} the best plan of the latest progress message, not yet painted */
let latestPlan = null;
const planPacer = createPacer(
  () => {
    if (latestPlan) planGrid.update(latestPlan);
  },
  { intervalMs: budget.chartIntervalMs },
);
const worker = new Worker(new URL("../worker.js", import.meta.url), { type: "module" });
/** @type {number} */
let runStartedAt = 0;
worker.addEventListener("message", (event) => {
  const message = event.data;
  if (message.runId !== state.currentRunId) return; // a cancelled run still talking
  if (message.type === "progress") {
    evolutionView.append(message.generations);
    state.log.push(...message.generations);
    // The worker reports twenty times a second; the plan grid is repainted a few times a second.
    latestPlan = message.bestPlan;
    planPacer.request();
  } else if (message.type === "done") {
    finishRun(message);
  } else if (message.type === "error") {
    state.phase = "failed";
    setResultStatus(`The run failed: ${message.message}`, true);
    updateRunButtons();
    showRunEnded();
  }
});

arrangeButton.addEventListener("click", () => startRun());
stopButton.addEventListener("click", () => stopRun(false));
paceSelect.addEventListener("change", () => {
  state.pace = /** @type {"watch" | "full"} */ (paceSelect.value);
  if (state.phase === "evolving") {
    worker.postMessage({ type: "pace", runId: state.currentRunId, pace: state.pace });
  }
});

async function startRun() {
  if (!state.input) return;
  const messages = validateSettings(state.settings);
  if (messages.length) {
    setRunHint(messages.map((message) => message.message).join("; "), true);
    return;
  }
  player.ensureContext(); // inside the click: browsers allow sound only after a gesture
  player.pause();
  const settings = structuredClone(state.settings);
  const id = await runId(state.input.input.name, settings);
  state.currentRunId = id;
  state.phase = "evolving";
  state.log = [];
  settingsPanel.show(state.settings, true);
  runStartedAt = performance.now();
  evolutionView.reset({
    maxGenerations: settings.max_generations,
    stagnationWindow: settings.stagnation_window,
  });
  downloads.clear();
  setResultStatus("Evolving…");
  updateRunButtons();
  planPacer.cancel();
  latestPlan = null;
  showWorkbench("evolution");
  worker.postMessage({
    type: "run",
    runId: id,
    leadSheet: state.input.leadSheet,
    settings,
    pace: state.pace,
  });
}

/** @param {boolean} discard true when a new input replaces the running one */
function stopRun(discard) {
  if (state.phase !== "evolving") return;
  worker.postMessage({ type: "stop", runId: state.currentRunId });
  if (discard) {
    state.currentRunId = null;
    state.phase = "idle";
    setResultStatus("The run was cancelled: a new song was loaded.");
    updateRunButtons();
  }
}

/** @param {any} message the worker's `done` message */
async function finishRun(message) {
  const input = /** @type {LoadedInput} */ (state.input);
  const settings = structuredClone(state.settings);
  const leadSheet = input.leadSheet;
  const arrangement = assemble(leadSheet, message.bestPlan);
  planPacer.cancel();
  planGrid.update(message.bestPlan);
  evolutionView.finish({
    stopReason: message.stopReason,
    generations: message.generations,
    durationMs: message.durationMs ?? performance.now() - runStartedAt,
  });
  renderScores($("[data-scores]"), message.scores, message.bestFitness, settings.weights);
  const violations = findViolations(arrangement, leadSheet);
  if (violations.length) {
    state.phase = "failed";
    setResultStatus(`The arrangement breaks NES rules and will not play:\n${violations.join("\n")}`, true);
    updateRunButtons();
    showRunEnded();
    return;
  }
  state.phase = "realized";
  const context = player.ensureContext();
  const voices = originalVoices(input, leadSheet);
  const record = configRecord({
    settings,
    inputName: input.input.name,
    inputSha256: input.input.sha256,
    commit: version.commit,
    created: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    runId: /** @type {string} */ (state.currentRunId),
    bestFitness: message.bestFitness,
    stopReason: message.stopReason,
    generations: message.generations,
    app: {
      name: "chiptune-ga-arranger web",
      pace: state.pace,
      ...(input.input.catalogEntry
        ? { catalog_page: /** @type {{u: string}} */ (input.input.catalogEntry).u }
        : {}),
    },
  });
  const id = /** @type {string} */ (state.currentRunId);
  const downloadFiles = [
    {
      name: `${id}.mid`,
      label: "MIDI",
      hint: "The arrangement: four tracks P1, P2, TR and NO",
      blob: new Blob([arrangementToMidi(arrangement)], { type: "audio/midi" }),
    },
    {
      name: `${id}.config.json`,
      label: "Settings",
      hint: "The run record; the command line accepts it with --config",
      blob: new Blob([`${JSON.stringify(record, null, 2)}\n`], { type: "application/json" }),
    },
    {
      name: `${id}.wav`,
      label: "Audio (WAV)",
      hint: "The arrangement as you hear it: this sound pack and these channel levels",
      wav: true,
    },
    {
      name: `${id}.abc`,
      label: "Lead sheet",
      hint: "The lead sheet this run arranged, in ABC",
      blob: new Blob([writeLeadSheetAbc(leadSheet, { phraseLength: settings.phrase_length })], {
        type: "text/plain",
      }),
    },
  ];
  // The run keeps its notes for good and its sound only while it is on screen (`run-audio.js`).
  const run = {
    id,
    settings,
    bestFitness: message.bestFitness,
    message,
    arrangement,
    leadSheet,
    voices,
    tempoBpm: leadSheet.tempoBpm,
    durationBeats: totalBeats(leadSheet.bars),
    scenes: buildScenes(arrangement, voices, leadSheet.tempoBpm),
    audio: null,
    log: state.log,
    files: downloadFiles,
  };
  state.runs = addRun(state.runs, run);
  scenes = run.scenes;
  resultSound.showRun(run, state.soundPack, context.sampleRate, { fresh: true });
  downloads.set(withWav(downloadFiles, run));
  runsView.render(state.runs, id);
  settingsPanel.show(state.settings, false);
  state.phase = "ready";
  setResultStatus(
    `Best fitness ${message.bestFitness.toFixed(4)} after ${message.generations} generations.`,
  );
  updateRunButtons();
  showRunEnded();
}

/** @type {Promise<import("../core/leadsheet.js").LeadSheet> | null} */
let korobeiniki = null;
/** @type {string} */
let howDrawn = "";

/**
 * Draw How it works with the song on screen: the latest run's lead sheet and best plan when it
 * belongs to the loaded song, else the loaded song (or Korobeiniki) with the best random plan a
 * run would start from.
 */
async function drawHowItWorks() {
  const container = $("[data-how]");
  try {
    const run = state.runs.find((entry) => entry.id === state.currentRunId) ?? state.runs[0];
    const settings = validateSettings(state.settings).length === 0 ? state.settings : defaults;
    let input;
    if (run && (!state.input || run.leadSheet === state.input.leadSheet)) {
      input = { leadSheet: run.leadSheet, plan: run.message.bestPlan, settings: run.settings };
    } else {
      korobeiniki ??= (async () =>
        readLeadSheetAbc(await loadAbcjs(), await (await fetch("../data/leadsheets/korobeiniki.abc")).text(), {
          phraseLength: settings.phrase_length,
          roleMap: settings.role_map,
        }))();
      input = { leadSheet: state.input?.leadSheet ?? (await korobeiniki), plan: null, settings };
    }
    const key = `${run?.id ?? ""}|${state.input?.input.sha256 ?? "korobeiniki"}|${JSON.stringify(input.settings)}`;
    if (key === howDrawn) return;
    renderHowItWorks(container, howItWorksSteps(input));
    howDrawn = key;
  } catch (error) {
    container.textContent = `The figures could not be drawn: ${/** @type {Error} */ (error).message ?? error}`;
  }
}

/**
 * Bring back a run of the run list: its plan, curve, scores, sound and downloads.
 *
 * @param {string} id
 */
function showRun(id) {
  const run = state.runs.find((entry) => entry.id === id);
  if (!run || state.phase === "evolving") return;
  state.currentRunId = id;
  planGrid.setBars(run.leadSheet.bars);
  planGrid.update(run.message.bestPlan);
  evolutionView.show(run.log, {
    maxGenerations: run.settings.max_generations,
    stagnationWindow: run.settings.stagnation_window,
  });
  evolutionView.finish({
    stopReason: run.message.stopReason,
    generations: run.message.generations,
    durationMs: run.message.durationMs ?? 0,
  });
  renderScores($("[data-scores]"), run.message.scores, run.message.bestFitness, run.settings.weights);
  scenes = run.scenes;
  resultSound.showRun(run, state.soundPack, player.ensureContext().sampleRate, { fresh: true });
  downloads.set(withWav(run.files, run));
  runsView.render(state.runs, id);
  setResultStatus(`Run ${id}: best fitness ${run.message.bestFitness.toFixed(4)}.`);
}

// --- Result panel ---------------------------------------------------------------------------

playButton.addEventListener("click", () => {
  previewSource?.stop();
  previewSource = null;
  player.ensureContext();
  player.toggle();
});
seekInput.addEventListener("input", () => player.seek(Number(seekInput.value)));
const soundPackSelect = /** @type {HTMLSelectElement} */ ($("[data-sound-pack]"));
soundPackSelect.value = state.soundPack;
showSoundPack();
soundPackSelect.addEventListener("change", () => {
  state.soundPack = soundPackSelect.value;
  try {
    localStorage.setItem(SOUND_PACK_KEY, state.soundPack);
  } catch {
    // Without storage the choice lasts for this visit only.
  }
  showSoundPack();
  showPackLevels();
  const run = state.runs.find((entry) => entry.id === state.currentRunId);
  if (!run || state.phase === "evolving") return;
  // load keeps the position, the play state and the version heard, so the music goes on in the new sound.
  resultSound.showRun(run, state.soundPack, player.ensureContext().sampleRate, { fresh: false });
  downloads.set(withWav(run.files, run));
});
for (const button of document.querySelectorAll("[data-version]")) {
  button.addEventListener("click", () =>
    player.switchTo(/** @type {"original" | "arrangement"} */ (/** @type {HTMLElement} */ (button).dataset.version)),
  );
}
player.onChange(() => {
  playButton.disabled = player.duration() === 0;
  playButton.textContent = player.isPlaying() ? "Pause" : "Play";
  playButton.setAttribute("aria-label", playButton.textContent);
  seekInput.disabled = player.duration() === 0;
  seekInput.max = String(player.duration());
  for (const button of document.querySelectorAll("[data-version]")) {
    const element = /** @type {HTMLElement} */ (button);
    element.setAttribute("aria-pressed", String(element.dataset.version === player.active()));
    (/** @type {HTMLButtonElement} */ (element)).disabled = !player.has(/** @type {"original" | "arrangement"} */ (element.dataset.version));
  }
  // The toggle can only show what exists: a preview has the original and no arrangement.
  $("[data-versions]").hidden = !player.has("original");
  $('[data-version="arrangement"]').title = player.has("arrangement") ? "" : "Arrange the song to hear its arrangement";
  if (player.isPlaying() && !mixClosedByHand && globalThis.matchMedia?.("(min-width: 1100px)").matches) setMixDrawer(true);
  // The channel view sorts the scene's notes each time it gets one: only give it a new scene.
  const scene = scenes[player.active()];
  if (scene !== shownScene) {
    shownScene = scene;
    channelView.setScene(scene);
  }
});
/** @type {any} the scene the channel view holds */
let shownScene = null;
// The playhead loop runs on every animation frame, so it must cost almost nothing when nothing
// moved: it reads the player first, writes to the page only what changed (a write that changes
// nothing still invalidates style), and asks no question of the layout. A touch of the position
// slider is tracked by events, because asking `:active` would make the browser recalculate styles.
const timeText = $("[data-time]");
let seeking = false;
seekInput.addEventListener("pointerdown", () => (seeking = true));
for (const end of ["pointerup", "pointercancel", "change"]) seekInput.addEventListener(end, () => (seeking = false));
let shownClock = "";
let shownSeek = -1;
(function tick() {
  requestAnimationFrame(tick);
  const now = player.currentTime();
  channelView.draw(now); // draws only when the playhead moved, the scene changed or the canvas resized
  const text = `${clock(now)} / ${clock(player.duration())}`;
  if (text !== shownClock) {
    timeText.textContent = text;
    shownClock = text;
  }
  // A slider thumb moves less than a pixel in 100 ms on a song of any length.
  if (!seeking && Math.abs(now - shownSeek) >= 0.1) {
    seekInput.value = String(now);
    shownSeek = now;
  }
})();
document.addEventListener("keydown", (event) => {
  const target = /** @type {HTMLElement} */ (event.target);
  if (target.closest("input, textarea, select, button, a")) return;
  if (event.key === " ") {
    event.preventDefault();
    player.ensureContext();
    player.toggle();
  } else if (event.key === "a") player.switchTo("original");
  else if (event.key === "b") player.switchTo("arrangement");
  else if (event.key === "ArrowRight") player.seek(player.currentTime() + 2);
  else if (event.key === "ArrowLeft") player.seek(player.currentTime() - 2);
});

/** @type {AudioBufferSourceNode | null} */
let previewSource = null;

/**
 * Play one track of the loaded MIDI song alone, to help choose the melody (spec 005, story 2):
 * from the bar where it first plays, jumping over its long silences, for 8 playing bars.
 *
 * @param {number} index track index, as listed in the input panel
 * @returns {string} what the preview plays, for the input panel's status line
 */
function previewTrack(index) {
  const loaded = inputPanel.current();
  if (!loaded?.song || !loaded.leadSheet.sourceGrid) return "";
  const preview = trackPreview(loaded.song, {
    melodyTrack: index,
    sourceGrid: /** @type {[number, number]} */ (loaded.leadSheet.sourceGrid),
    bars: /** @type {[number, number]} */ (loaded.midi.bars ?? [0, loaded.leadSheet.bars.length]),
  });
  previewSource?.stop();
  previewSource = null;
  if (preview === null) return `Track ${index} has no notes to play.`;
  const context = player.ensureContext();
  player.pause();
  const rendered = renderVoices(preview.voices, loaded.leadSheet.tempoBpm, context.sampleRate, preview.durationBeats);
  const samples = matchLoudness(rendered, rendered, context.sampleRate).a;
  const buffer = context.createBuffer(1, samples.length, context.sampleRate);
  buffer.copyToChannel(samples, 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(player.output()); // through the master volume, like everything else
  source.start();
  source.onended = () => {
    if (previewSource === source) previewSource = null;
    source.disconnect();
  };
  previewSource = source;
  return preview.inExcerpt
    ? `Playing track ${index} from bar ${preview.firstBar}, where it comes in.`
    : `Track ${index} plays nothing in the excerpt; playing it from bar ${preview.firstBar}, where it first plays in the song.`;
}

/**
 * The notes of the input, in beats: the lead sheet played plainly for ABC, or every track of the
 * MIDI excerpt (FR-021).
 *
 * @param {LoadedInput} input
 * @param {import("../core/leadsheet.js").LeadSheet} leadSheet
 */
function originalVoices(input, leadSheet) {
  if (!input.song) return leadSheetVoices(leadSheet);
  const bars = input.midi.bars ?? [0, leadSheet.bars.length];
  return midiExcerptVoices(input.song, {
    melodyTrack: /** @type {number} */ (input.midi.melody_track),
    sourceGrid: /** @type {[number, number]} */ (leadSheet.sourceGrid),
    bars: /** @type {[number, number]} */ (bars),
  });
}

/**
 * What the channel view draws for each version, in seconds.
 *
 * @param {any} arrangement
 * @param {import("../audio/plain-synth.js").Voices} voices
 * @param {number} tempoBpm
 */
function buildScenes(arrangement, voices, tempoBpm) {
  const seconds = 60 / tempoBpm;
  const inSeconds = (/** @type {Array<{pitch: number, onset: number, duration: number}>} */ notes) =>
    notes.map((note) => ({ pitch: note.pitch, onset: note.onset * seconds, duration: note.duration * seconds }));
  return {
    arrangement: {
      label: "The arrangement: P1 melody, P2 harmony and TR bass as lines, NO drums as ticks",
      lines: [
        { color: "--tr", notes: inSeconds(arrangement.channels.TR), monophonic: true },
        { color: "--p2", notes: inSeconds(arrangement.channels.P2), monophonic: true, width: 2 },
        { color: "--p1", notes: inSeconds(arrangement.channels.P1), monophonic: true, width: 3 },
      ],
      drums: arrangement.channels.NO.map((/** @type {{onset: number}} */ hit) => hit.onset * seconds),
    },
    original: originalScene(voices, tempoBpm),
  };
}

/**
 * The channel view's scene of the original: the melody as a blue line, the other parts as faint dashes.
 *
 * @param {{melody: any[], others: any[][], drums: any[]}} voices
 * @param {number} tempoBpm
 */
function originalScene(voices, tempoBpm) {
  const seconds = 60 / tempoBpm;
  const inSeconds = (/** @type {Array<{pitch: number, onset: number, duration: number}>} */ notes) =>
    notes.map((note) => ({ pitch: note.pitch, onset: note.onset * seconds, duration: note.duration * seconds }));
  return {
    label: "The original: the melody as a blue line, the other parts as faint dashes",
    lines: [
      ...voices.others.map((notes) => ({
        color: "--muted",
        notes: inSeconds(notes),
        monophonic: false,
        faint: true,
      })),
      { color: "--p1", notes: inSeconds(voices.melody), monophonic: false, width: 3 },
    ],
    drums: voices.drums.map((hit) => hit.onset * seconds),
  };
}

// --- Helpers --------------------------------------------------------------------------------

function updateRunButtons() {
  const evolving = state.phase === "evolving";
  const valid = validateSettings(state.settings).length === 0;
  if (document.activeElement !== seedInput && Number.isFinite(state.settings.seed)) {
    seedInput.value = String(state.settings.seed);
  }
  showChangedSettings();
  arrangeButton.disabled = !state.input || evolving || !valid;
  stopButton.disabled = !evolving;
  stopEvolutionButton.disabled = !evolving;
  if (!state.input) setRunHint("");
  else if (!valid) setRunHint(validateSettings(state.settings).map((m) => m.message).join("; "), true);
  else if (evolving) setRunHint("Evolving… changes apply to the next run.");
  else setRunHint("Ready to arrange.");
}

/** Show the settings that differ from the defaults as chips on the Run card. */
function showChangedSettings() {
  const box = $("[data-changed]");
  box.innerHTML = "";
  for (const key of changedSettings(state.settings, defaults)) {
    if (key.startsWith("midi.")) continue; // the Song card shows the MIDI options
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "changed mono";
    chip.textContent = `${settingLabel(key)} ${settingValueText(key, valueAt(state.settings, key))}`;
    chip.title = "Open the settings";
    chip.addEventListener("click", () => toggleSettings(true));
    box.append(chip);
  }
}

/**
 * Open (true), close (false) or flip (undefined) the Settings drawer, which slides in over the
 * right side of the page without moving it. Focus moves into the drawer on opening and back to
 * its button on closing.
 *
 * @param {boolean} [open]
 */
function toggleSettings(open) {
  const section = $("#settings");
  const isOpen = section.classList.contains("open");
  const show = open ?? !isOpen;
  if (show === isOpen) return;
  section.classList.toggle("open", show);
  settingsToggle.setAttribute("aria-expanded", String(show));
  settingsToggle.textContent = show ? "Hide settings" : "Settings";
  if (show) $("#settings-title").focus({ preventScroll: true });
  else if (section.contains(document.activeElement)) settingsToggle.focus();
}

/**
 * @param {string} text
 * @param {boolean} [isError]
 */
function setRunHint(text, isError = false) {
  const hint = $("[data-run-hint]");
  hint.textContent = text;
  hint.classList.toggle("error", isError);
}

/**
 * @param {string} text
 * @param {boolean} [isError]
 */
function setResultStatus(text, isError = false) {
  const status = $("[data-result-status]");
  status.textContent = text;
  status.classList.toggle("error", isError);
}

/** @param {string} selector */
function clearPlaceholder(selector) {
  document.querySelector(`${selector} .placeholder`)?.remove();
}

/** @param {number} seconds */
function clock(seconds) {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** @param {string} path */
async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

// Expose the run list for the settings and run-list panels (User Story 2).
export { state, inputPanel, player };

// --- Sound packs ----------------------------------------------------------------------------

/** The sound pack chosen on an earlier visit, or the NES chip. @returns {string} */
function storedSoundPack() {
  try {
    const stored = localStorage.getItem(SOUND_PACK_KEY);
    if (stored && SOUND_PACKS.some((pack) => pack.id === stored)) return stored;
  } catch {
    // Storage can be blocked (private windows, previews): fall back to the default.
  }
  return SOUND_PACKS[0].id;
}

/** Name the arrangement's button after the pack, and say how the pack sounds. */
function showSoundPack() {
  const pack = SOUND_PACKS.find((entry) => entry.id === state.soundPack) ?? SOUND_PACKS[0];
  $('[data-version="arrangement"]').textContent = pack.name;
  $("[data-sound-pack-hint]").textContent = pack.description;
}
