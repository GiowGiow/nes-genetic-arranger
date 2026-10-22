// @ts-check
/**
 * Run list: the last runs of a visit, to compare what the settings changed (spec 002, FR-019).
 *
 * The GA's behavior is the subject of the project: change the seed, the fidelity weight or the
 * stopping window, arrange again, and compare. The list keeps the last 5 runs, newest first, and
 * describes each one by its seed, the settings that differ from the defaults (the orange chips
 * of the listening page) and its best fitness. These functions are pure; `runs.js` draws them.
 */

import { changedSettings, valueAt } from "./settings-form.js";
import { settingLabel, settingValueText } from "./settings-panel.js";

/** How many runs a visit keeps. */
export const RUN_LIMIT = 5;

/**
 * A run of the visit. `audio` holds the big sound buffers (`audio/run-audio.js`) and is null for
 * every run but the one on screen.
 * @typedef {{id: string, settings: import("../core/settings.js").Settings, bestFitness: number, audio?: unknown}} RunEntry
 */

/**
 * Put a run at the head of the list, drop an older run with the same id and keep RUN_LIMIT runs.
 *
 * @template {RunEntry} T
 * @param {T[]} runs
 * @param {T} run
 * @returns {T[]} a new list
 * @example
 * addRun([], {id: "a-s1-00000000", settings, bestFitness: 0.9}).length // 1
 */
export function addRun(runs, run) {
  return [run, ...runs.filter((entry) => entry.id !== run.id)].slice(0, RUN_LIMIT);
}

/**
 * Free the sound buffers of every run but one, so a visit holds the audio of the run on screen and
 * not of all five (see `audio/run-audio.js`). The runs stay in the list; one that is brought back
 * renders its sound again. This changes the entries in place.
 *
 * @param {RunEntry[]} runs
 * @param {string | null} keepId the run that keeps its audio; null frees every run's
 * @returns {number} how many runs gave up their audio
 * @example
 * releaseAudio(runs, newRun.id); // the older runs are now only their notes
 */
export function releaseAudio(runs, keepId) {
  let freed = 0;
  for (const run of runs) {
    if (run.id !== keepId && run.audio) {
      run.audio = null;
      freed += 1;
    }
  }
  return freed;
}

/**
 * The run on screen, when it belongs to the song that is loaded.
 *
 * A run's lead sheet is the reading of the song it arranged. Reading the song again (another
 * melody track, other bars) makes a new lead sheet, so a run of the old reading is not the run
 * of this song.
 *
 * @param {Array<RunEntry & {leadSheet?: unknown}>} runs
 * @param {string | null} currentRunId the id of the run on screen, if any
 * @param {unknown} leadSheet the loaded song's lead sheet
 * @returns {(RunEntry & {leadSheet?: unknown}) | null}
 * @example
 * runShown(state.runs, state.currentRunId, input.leadSheet); // the run, or null
 */
export function runShown(runs, currentRunId, leadSheet) {
  if (currentRunId === null || !leadSheet) return null;
  const run = runs.find((entry) => entry.id === currentRunId);
  return run && run.leadSheet === leadSheet ? run : null;
}

/**
 * How many runs hold sound buffers.
 *
 * @param {RunEntry[]} runs
 * @returns {number}
 */
export function audioHolders(runs) {
  return runs.filter((run) => run.audio).length;
}

/**
 * What the run list shows for one run.
 *
 * @param {RunEntry} run
 * @param {import("../core/settings.js").Settings} defaults
 * @returns {{id: string, seed: number, changed: Array<{key: string, label: string, value: string}>, fitness: string}}
 * @example
 * describeRun({id: "x", settings: {...defaults, seed: 3}, bestFitness: 0.9}, defaults).changed // []
 */
export function describeRun(run, defaults) {
  const changed = changedSettings(run.settings, defaults).map((key) => ({
    key,
    label: settingLabel(key),
    value: settingValueText(key, valueAt(run.settings, key)),
  }));
  return { id: run.id, seed: run.settings.seed, changed, fitness: run.bestFitness.toFixed(4) };
}
