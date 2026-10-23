// @ts-check
/**
 * Page wiring: input, settings, the GA worker, the evolution display, playback and downloads.
 *
 * The song shelf's glue lives in `catalog-glue.js` (catalog, The Session, song cache, downloads),
 * the Settings and mixer drawers in `drawers.js`; toasts (`notify.js`) and busy states
 * (`busy.js`) are shared. This file keeps what is left: the run and the result.
 *
 * A run goes through the states of data-model.md ("Run state"):
 *
 *   idle → evolving → realized → ready (or failed when the arrangement breaks an NES rule)
 *
 * The genetic algorithm runs in a module worker (`../worker.js`), so the page stays responsive
 * (FR-015). The page sends `run` and `stop` messages and draws every `progress` message
 * (contracts/worker-protocol.md). When the worker is `done`, the page realizes the best plan into
 * notes and checks the NES rules, shows the Result at once and asks a second worker
 * (`../audio/render-worker.js`) to render the sound, so the page never freezes for it: a change of
 * sound pack keeps the old pack playing until the new one is ready. Dropping a new file during a
 * run stops it and discards it.
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
import { createAudioRenderer } from "../audio/audio-renderer.js";
import { createPlayer } from "../audio/player.js";
import { SOUND_PACKS, knownSoundPack } from "../audio/sound-packs.js";
import { defaultLevels, mixStems, readLevels, readVolume, storeLevels, storeVolume } from "../audio/mixer.js";
import { encodeWav } from "../audio/wav.js";
import { createCatalogGlue } from "./catalog-glue.js";
import { createChannelView } from "./channel-view.js";
import { createDownloads, formatSize } from "./downloads.js";
import { setUpDrawers } from "./drawers.js";
import { createEvolutionLab } from "./evolution-lab.js";
import { createInputPanel, loadAbcjs } from "./input-panel.js";
import { howItWorksSteps, renderHowItWorks, renderHowSkeleton } from "./how-it-works.js";
import { readLeadSheetAbc } from "../core/abc-reader.js";
import { createMixerPanel } from "./mixer-panel.js";
import { setBusy } from "./busy.js";
import { notify, statusToast } from "./notify.js";
import { drawingBudget } from "./pacing.js";
import { addRun, runShown } from "./run-list.js";
import { createResultEvolving } from "./result-evolving.js";
import { createResultSound } from "./result-sound.js";
import { createTurntable } from "./turntable-view.js";
import { localEntry } from "../core/sources.js";
import { createVolumeSlider } from "./volume-slider.js";
import { setUpThemeToggle } from "./theme.js";
import { clearScores, renderScores } from "./scores-table.js";
import { changedSettings, valueAt } from "./settings-form.js";
import { createRunsView } from "./runs.js";
import { createSettingsPanel, settingLabel, settingValueText } from "./settings-panel.js";
import { setUpPageTabs } from "./tabs.js";

/** @typedef {import("./input-panel.js").LoadedInput} LoadedInput */
/** @typedef {import("../core/settings.js").Settings} Settings */

const $ = (/** @type {string} */ selector) =>
  /** @type {HTMLElement} */ (document.querySelector(selector));

// index.html starts these two small files while the modules load (`window.__early`), so they are
// usually here by the time this line runs.
const early = /** @type {any} */ (globalThis).__early;
const [version, defaultConfig] = await Promise.all([
  (early?.version ?? fetchJson("version.json")).catch(() => ({ commit: "dev" })),
  early?.config ?? fetchJson("../configs/default.json"),
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

/** Local storage when the browser allows it; without it the levels last for this visit only. */
const levelStorage = (() => {
  try {
    return localStorage;
  } catch {
    return null;
  }
})();

// Light or dark (ui/theme.js); the first paint already has it, from index.html's inline script.
setUpThemeToggle($("[data-theme-toggle]"), /** @type {any} */ (levelStorage ?? { getItem: () => null, setItem: () => {} }));

// --- Panels ---------------------------------------------------------------------------------

/** What a phone cannot afford while it plays music (see pacing.js): a touch screen gets the smaller budget. */
const budget = drawingBudget(globalThis.matchMedia?.("(pointer: coarse)").matches ?? false);

const pageTabs = setUpPageTabs($("[data-page-tabs]"), {
  viewNav: $("[data-view-tabs]"),
  // The figures are drawn only when the tab is open; a timeout lets the page finish wiring first.
  onChange: (id) => {
    placeRunStrip(id);
    if (id === "how") setTimeout(drawHowItWorks);
    if (id === "evolution") document.querySelector('[data-tab="evolution"]')?.classList.remove("has-news");
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
  onFileDropped: (name) => catalogGlue.claimDownload(name),
  onStatus: statusToast,
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
    lab.setSong(loaded.leadSheet, { maxGenerations: state.settings.max_generations, stagnationWindow: state.settings.stagnation_window });
    turntable.setRecord(recordEntry(loaded));
    $("[data-run-song]").textContent =
      `${loaded.leadSheet.title || loaded.input.name} (${loaded.leadSheet.bars.length} bars)`;
    updateRunButtons();
    if (pageTabs.current() === "how") drawHowItWorks();
    catalogGlue.rememberOwnSong(loaded);
    catalogGlue.rememberDownload(loaded);
  },
  },
);

// --- Song catalog: one shelf of records, examples first (spec 005, story 3) ------------------

// The shelf, the catalog, The Session, the song cache and the downloads (ui/catalog-glue.js).
const catalogGlue = createCatalogGlue({
  shelfRoot: $("[data-shelf]"),
  elements: {
    status: $("[data-status]"),
    forgetNote: $("[data-forget]"),
    forgetButton: $("[data-forget-songs]"),
    openFileButton: $("[data-open-file]"),
    fileInput: /** @type {HTMLInputElement} */ ($("[data-file]")),
  },
  inputPanel: () => inputPanel,
  isEvolving: () => state.phase === "evolving",
  stopRun,
  startRun,
  playIntro,
});
// The shelf has mounted and shows its own skeleton: the static placeholder that held its room goes.
$("[data-shelf]").querySelector("[data-shelf-boot]")?.remove();

/**
 * Preview on a record: the song's original, in the Result's player, so the position, the turntable,
 * the channel view and the mixer are there as after a run.
 *
 * - When the run on screen is for this song, its own original plays from the start (the same
 *   sound as the Original button), and the arrangement stays one click away.
 * - Otherwise nothing of an earlier song may stay in the player: the first 8 bars of the loaded
 *   song, as the input sounds, are the only version loaded. The toggle shows the original and the
 *   arrangement button is disabled, because there is no arrangement of this song yet.
 *
 * The Result opens at once, with the record on the turntable, and the 8 bars are rendered by the
 * render worker, so the page does not freeze or jump (audit L15). Returns when the preview plays.
 *
 * @returns {Promise<void>}
 */
async function playIntro() {
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
  turntable.setRecord(recordEntry(loaded));
  setResultStatus(`Preparing the preview of ${loaded.leadSheet.title || loaded.input.name}…`);
  showWorkbench("result");
  const voices = originalVoices(loaded, loaded.leadSheet);
  const beats = Math.min(totalBeats(loaded.leadSheet.bars.slice(0, 8)), totalBeats(loaded.leadSheet.bars));
  let samples;
  try {
    samples = await renderer.renderOriginal(voices, loaded.leadSheet.tempoBpm, context.sampleRate, beats);
  } catch (error) {
    if (/** @type {any} */ (error)?.stale) return;
    setResultStatus(`The preview could not be made: ${/** @type {Error} */ (error).message}`, true);
    return;
  }
  // The visitor may have chosen another song, or started a run, while it rendered.
  if (inputPanel.current() !== loaded || state.phase === "evolving") return;
  const scene = originalScene(clipVoices(voices, beats), loaded.leadSheet.tempoBpm);
  scenes = { arrangement: scene, original: scene };
  resultSound.showIntro(samples, context.sampleRate);
  setResultStatus(
    `Preview of ${loaded.leadSheet.title || loaded.input.name}: its first 8 bars, as the original sounds. Press Arrange to arrange it.`,
  );
  player.play();
}

/**
 * The record of a loaded song: its catalog entry, or one made from the opened file's hash, the
 * same record the shelf shows for it (`record-art.js`).
 *
 * @param {LoadedInput} loaded
 */
function recordEntry(loaded) {
  return (
    /** @type {import("../core/sources.js").CatalogEntry | null} */ (loaded.input.catalogEntry) ??
    localEntry({ name: loaded.input.name, sha256: loaded.input.sha256, leadSheet: loaded.leadSheet })
  );
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
  clearScores($("[data-scores]"));
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
  // A run brings its bar to the top. A preview only makes sure the Result is in sight, at once:
  // no smooth sweep over the page, so the shelf the visitor came from does not seem to fly away.
  requestAnimationFrame(() =>
    document.getElementById("workbench")?.scrollIntoView(view === "result" ? { block: "nearest", behavior: "instant" } : { block: "start" }),
  );
}

/**
 * A run ended, with a result or with the reason it has none: show the Result view, which holds the
 * status line. It is the Result view even if the visitor chose the Evolution view by hand during the
 * run. When the Evolution tab is open and has been scrolled past its top, bring the result back into
 * sight. When the visitor went to another tab during the run, the page does not pull them back: the
 * Run tab gets a dot and a message offers to open the result.
 */
function showRunEnded() {
  pageTabs.showView("result");
  const workbench = document.getElementById("workbench");
  if (pageTabs.current() === "evolution") {
    if (workbench && workbench.getBoundingClientRect().top < 0) {
      requestAnimationFrame(() => workbench.scrollIntoView({ block: "start" }));
    }
    return;
  }
  document.querySelector('[data-tab="evolution"]')?.classList.add("has-news");
  notify("The arrangement is ready.", { action: { label: "View", run: () => pageTabs.show("evolution") } });
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
    if (state.phase === "evolving") setRunHint("Changes apply to the next run.");
  },
});
settingsPanel.show(state.settings, false);

const lab = createEvolutionLab($("#evolution"), {
  budget,
  weights: defaults.weights,
  onStop: () => stopRun(false),
  onChooseSong: () => pageTabs.show("song"),
});
const arrangeButton = /** @type {HTMLButtonElement} */ ($("[data-arrange]"));
const stopButton = /** @type {HTMLButtonElement} */ ($("[data-stop]"));
// The Run card scrolls away while the evolution plays, so the Evolution card has its own Stop.
const stopEvolutionButton = lab.stopButton;
const paceSelect = /** @type {HTMLSelectElement} */ ($("[data-pace]"));
const seedInput = /** @type {HTMLInputElement} */ ($("[data-seed]"));
seedInput.addEventListener("input", () => {
  state.settings.seed = seedInput.value.trim() === "" ? NaN : Number(seedInput.value);
  updateRunButtons();
});

clearPlaceholder("#result");
$("#result").insertAdjacentHTML(
  "beforeend",
  `<div data-result-evolving hidden></div>
   <div data-result-body>
   <div class="transport">
     <div class="transport-main">
       <button type="button" class="button primary" data-play disabled aria-label="Play">Play</button>
       <input type="range" min="0" max="1" step="0.01" value="0" data-seek aria-label="Position" disabled>
       <span class="mono time" data-time>0:00 / 0:00</span>
     </div>
     <div class="transport-options">
       <div class="versions" role="group" aria-label="Version" data-versions hidden>
         <button type="button" class="button" data-version="original">Original</button>
         <button type="button" class="button" data-version="arrangement" aria-pressed="true">NES chip</button>
       </div>
       <label class="sound-pack"><span class="sound-label">Sound</span>
         <select data-sound-pack aria-describedby="sound-pack-hint">
           ${SOUND_PACKS.map((pack) => `<option value="${pack.id}">${pack.name}</option>`).join("")}
         </select><span class="pack-spinner spinner" data-pack-spinner hidden role="status" aria-label="Rendering the new sound"></span></label>
       <span data-volume-slot></span>
       <button type="button" class="button" data-mix-toggle aria-expanded="false" aria-controls="mix">Mix</button>
     </div>
   </div>
   <p class="hint sound-pack-hint" id="sound-pack-hint" data-sound-pack-hint></p>
   <p class="status" data-result-status role="status" aria-live="polite">No arrangement yet.</p>
   <div class="result-stage">
     <div class="turntable-slot" data-turntable></div>
     <div data-channel-view></div>
   </div>
   <details class="more">
     <summary>How to read the turntable and the lines</summary>
     <p>The song is a record on a turntable: it turns while the music plays and the tonearm crosses
     it, so the arm shows how far you are. Drag the arm, or anywhere on the record, to jump there. The
     lines are the channels, each in its color, revealed as it plays: P1 melody (blue),
     P2 harmony (orange), TR bass (gray) and NO drums as ticks at the bottom. Switch to the original
     to see its melody in blue and the other parts as faint dashes. Keys: space plays, A and B
     switch, the arrows move 2 s, Home and End jump to the ends of the song.</p>
   </details>
   <h3 class="subhead">Fitness criteria</h3>
   <div class="scores" data-scores></div>
   <details class="more">
     <summary>How to read the meters</summary>
     <p>Each needle is one criterion of the final plan, from 0 at the left to 1 at the right, with its
     weight under it. The fitness is their weighted mean; the needle that leans least is what holds the
     arrangement back.</p>
   </details>
   <div data-downloads></div>
   <div data-runs></div>
   </div>`,
);
const resultEvolving = createResultEvolving($("[data-result-evolving]"));
const player = createPlayer();
// The sound of a run is rendered in a worker, so the page never freezes for it (audit L12, L13).
const renderer = createAudioRenderer();
const resultSound = createResultSound({ player, runs: () => state.runs, renderer });

/** @type {ReturnType<typeof setTimeout> | undefined} */
let levelsTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let volumeTimer;
const savedVolume = readVolume(levelStorage);
const mixerPanel = createMixerPanel($("[data-mixer]"), {
  volume: savedVolume,
  readMeters: () => player.channelLevels(),
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

// The settings and mixer drawers: buttons, focus, Escape, and the mixer opening by itself when
// something plays on a wide screen (ui/drawers.js).
const drawers = setUpDrawers({
  settings: $("#settings"),
  settingsTitle: $("#settings-title"),
  settingsToggle: $("[data-settings-toggle]"),
  settingsClose: $("[data-settings-close]"),
  mix: $("#mix"),
  mixToggle: $("[data-mix-toggle]"),
  mixClose: $("[data-mix-close]"),
  // The meters read the analysers only while the mixer is open and the music plays.
  onMixChange: (open) => mixerPanel.setMetering(open && player.isPlaying()),
});

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
      busyLabel: "Mixing…",
      emptyMessage: "Every channel is muted: nothing to save.",
      sizeText: wavSizeText(run),
      make: () => {
        const levels = mixerPanel.get();
        if (!run.audio) throw new Error("the sound is still being rendered");
        if (Object.values(levels.muted).every(Boolean)) return null;
        const bytes = encodeWav(mixStems(/** @type {any} */ (run.audio.stems), levels), run.audio.sampleRate);
        return new Blob([bytes], { type: "audio/wav" });
      },
    };
  });
}

/**
 * About how big the WAV will be: 16-bit mono at 44.1 kHz (the usual rate of a sound card) over the
 * song's length. The label says "about" because the real rate depends on the visitor's device.
 *
 * @param {{tempoBpm: number, durationBeats: number}} run
 * @returns {string} for example "about 9 MB"
 */
function wavSizeText(run) {
  const seconds = (run.durationBeats * 60) / run.tempoBpm;
  return formatSize(44 + 2 * Math.ceil(seconds * 44100));
}
const downloads = createDownloads($("[data-downloads]"));
const channelView = createChannelView($("[data-channel-view]"), budget);
// The result as a record on a turntable: it turns while the music plays, and the arm is the
// progress bar (drag it to seek). The step-line view beside it keeps the notes.
const turntable = createTurntable($("[data-turntable]"), {
  clock: { time: () => player.currentTime(), duration: () => player.duration(), playing: () => player.isPlaying() },
  seek: (seconds) => player.seek(seconds),
});
/** @type {{arrangement: any, original: any}} */
let scenes = { arrangement: null, original: null };
const runsView = createRunsView($("[data-runs]"), { defaults, onSelect: (id) => showRun(id) });
const playButton = /** @type {HTMLButtonElement} */ ($("[data-play]"));
const seekInput = /** @type {HTMLInputElement} */ ($("[data-seek]"));

// --- Worker ---------------------------------------------------------------------------------

const worker = new Worker(new URL("../worker.js", import.meta.url), { type: "module" });
/** Whether the worker has loaded its modules and is listening (it says `ready`). */
let workerReady = false;
/** @type {number} */
let runStartedAt = 0;
/** Which criteria the worker said can apply to the run on screen (its `started` message). @type {Record<string, boolean>} */
let applicable = {};
worker.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "ready") {
    workerReady = true;
    return;
  }
  if (message.runId !== state.currentRunId) return; // a cancelled run still talking
  if (message.type === "started") {
    applicable = message.tables?.applicable ?? {};
    lab.started(message);
  } else if (message.type === "progress") {
    state.log.push(...message.generations);
    // The lab redraws a few times a second, though the worker reports twenty.
    lab.progress(message);
    updateScreen();
    resultEvolving.update({ last: lab.last(), maxGenerations: state.settings.max_generations, previousFitness: previousFitness() });
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
  applicable = {};
  lab.begin({ settings, leadSheet: state.input.leadSheet });
  downloads.clear();
  setResultStatus("Evolving…");
  resultEvolving.update({ last: null, maxGenerations: settings.max_generations, previousFitness: previousFitness() });
  updateRunButtons();
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
  lab.finish(message, {
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
    applicable,
  };
  state.runs = addRun(state.runs, run);
  scenes = run.scenes;
  downloads.set(withWav(downloadFiles, run));
  runsView.render(state.runs, id);
  settingsPanel.show(state.settings, false);
  state.phase = "ready";
  const summary = `Best fitness ${message.bestFitness.toFixed(4)} after ${message.generations} generations.`;
  setResultStatus(`${summary} Rendering the sound…`);
  // The Result opens now, with the record on the turntable and Play waiting; the sound is rendered
  // by the render worker, and the page stays live meanwhile (audit L12).
  updateRunButtons();
  showRunEnded();
  try {
    await showRunSound(run, { fresh: true });
    setResultStatus(summary);
  } catch (error) {
    setResultStatus(`${summary} The sound could not be rendered: ${/** @type {Error} */ (error).message}`, true);
  }
}

/** How many renders of the sound are going; the Result is marked busy while any is. */
let soundRenders = 0;

/**
 * Render a run's sound for the chosen pack and load it into the player, marking the Result's
 * transport busy meanwhile. A render the visitor replaces (another pack, another run) ends in
 * nothing, and the newer one decides when the transport is free again.
 *
 * @param {any} run
 * @param {{fresh: boolean}} options `fresh`: the run has just ended or been picked
 * @returns {Promise<boolean>} whether this render is the one now in the player
 */
async function showRunSound(run, { fresh }) {
  const transport = $(".transport");
  const spinner = $("[data-pack-spinner]");
  soundRenders += 1;
  transport.setAttribute("aria-busy", "true");
  spinner.hidden = false;
  try {
    const audio = await resultSound.showRunAsync(run, state.soundPack, player.ensureContext().sampleRate, { fresh });
    if (audio === null) return false;
    downloads.set(withWav(run.files, run));
    return true;
  } finally {
    soundRenders -= 1;
    if (soundRenders === 0) {
      transport.removeAttribute("aria-busy");
      spinner.hidden = true;
    }
  }
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
  // The first time, the tab opens at once on grey placeholders while the figures are made.
  if (howDrawn === "") renderHowSkeleton(container);
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
    container.removeAttribute("aria-busy");
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
  lab.show(run);
  renderScores($("[data-scores]"), run.message.scores, run.message.bestFitness, run.settings.weights);
  scenes = run.scenes;
  downloads.set(withWav(run.files, run));
  runsView.render(state.runs, id);
  const summary = `Run ${id}: best fitness ${run.message.bestFitness.toFixed(4)}.`;
  setResultStatus(`${summary} Rendering the sound…`);
  showRunSound(run, { fresh: true }).then(
    (shown) => shown && setResultStatus(summary),
    (error) => setResultStatus(`${summary} The sound could not be rendered: ${error.message}`, true),
  );
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
  // The old pack keeps playing while the new one renders in the worker; then it is swapped in and
  // the music goes on in the same place and the same version. Choosing again meanwhile replaces
  // the render, and only the last choice is loaded.
  const choice = state.soundPack;
  showRunSound(run, { fresh: false }).catch((error) => {
    notify(`The ${SOUND_PACKS.find((pack) => pack.id === choice)?.name ?? "new"} sound could not be rendered: ${error.message}`, { kind: "error" });
    if (run.audio) {
      state.soundPack = run.audio.pack;
      soundPackSelect.value = state.soundPack;
      showSoundPack();
      showPackLevels();
    }
  });
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
  turntable.wake(); // the record turns or coasts to a stop, and the arm follows a seek
  // The toggle can only show what exists: a preview has the original and no arrangement.
  $("[data-versions]").hidden = !player.has("original");
  $('[data-version="arrangement"]').title = player.has("arrangement") ? "" : "Arrange the song to hear its arrangement";
  if (player.isPlaying()) drawers.hintMix();
  mixerPanel.setMetering(player.isPlaying() && drawers.isMixOpen());
  // The channel view sorts the scene's notes each time it gets one: only give it a new scene.
  const scene = scenes[player.active()];
  if (scene !== shownScene) {
    const switching = shownScene !== null && scene !== null; // A/B: the lines dissolve into the other version's
    shownScene = scene;
    channelView.setScene(scene);
    if (switching && !globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      document.querySelector("[data-channel-view] canvas")?.animate([{ opacity: 0.3 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
    }
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
  // While a run goes, Arrange says so (a spinning record and "Evolving…") instead of only dimming.
  if (evolving) {
    setBusy(arrangeButton, true, "Evolving…");
  } else {
    setBusy(arrangeButton, false);
    arrangeButton.disabled = !state.input || !valid;
  }
  stopButton.disabled = !evolving;
  stopEvolutionButton.disabled = !evolving;
  // Before a run, the lab already states the steps this song and these settings will take.
  if (!evolving && state.input && state.currentRunId === null && valid) lab.setPlan(state.settings, state.input.leadSheet);
  if (!state.input) setRunHint("");
  else if (!valid) setRunHint(validateSettings(state.settings).map((m) => m.message).join("; "), true);
  else setRunHint("");
  showEvolvingState(evolving);
}

/**
 * Show what depends on a run going on: the Evolution view is busy, the Result says "evolving"
 * instead of showing the previous run, and the scope's screen shows INSERT COIN while a run waits
 * to start or is starting.
 *
 * @param {boolean} evolving
 */
function showEvolvingState(evolving) {
  $("#evolution").setAttribute("aria-busy", String(evolving));
  const result = $("#result");
  result.classList.toggle("is-evolving", evolving);
  if (evolving) result.setAttribute("aria-busy", "true");
  else result.removeAttribute("aria-busy");
  $("[data-result-evolving]").hidden = !evolving;
  $("[data-result-body]").hidden = evolving;
  updateScreen();
}

/** The scope's screen: INSERT COIN while waiting for a run, and while the first generation is on its way. */
function updateScreen() {
  lab.setScreen({
    hasSong: state.input !== null,
    running: state.phase === "evolving",
    generations: state.log.length,
    hasRun: lab.last() !== null || state.phase !== "idle",
  });
}

/** The fitness of the newest run, as the number the evolving state reminds of; null with none. @returns {number | null} */
function previousFitness() {
  return state.runs[0]?.bestFitness ?? null;
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
    chip.addEventListener("click", () => drawers.toggleSettings(true));
    box.append(chip);
  }
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
  // A failure must not wait below the fold for someone to scroll to it.
  if (isError) notify(text, { kind: "error" });
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
    return knownSoundPack(localStorage.getItem(SOUND_PACK_KEY));
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
