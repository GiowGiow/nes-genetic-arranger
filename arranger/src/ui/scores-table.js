// @ts-check
/**
 * Scores: how the best plan scored on each of the seven fitness criteria.
 *
 * The fitness is the weighted mean of the criterion scores, each from 0 to 1 (`core/fitness.js`).
 * The Result shows them as VU meters (`vu-meters.js`), so the criterion that holds the fitness
 * back is the needle that leans least. `describeScores` is the same information as plain rows
 * (name, weight, two-decimal score, bar share): the numbers the meters and any text view share.
 * A criterion that does not apply to the song (contrast without a chorus) has no score and drops
 * out of the mean.
 */

import { CRITERIA } from "../core/fitness.js";
import { createVuMeters } from "./vu-meters.js";

/** Criterion names as the settings panel shows them. */
const CRITERION_LABELS = Object.freeze({
  complementarity: "Complementarity",
  register: "Register",
  coherence: "Coherence",
  contrast: "Contrast",
  bass_smoothness: "Bass smoothness",
  idiom: "NES idiom",
  fidelity: "Fidelity",
});

/**
 * @typedef {{name: string, label: string, weight: string, score: string, bar: number | null}} ScoreRow
 */

/**
 * What the table shows for a plan's scores.
 *
 * @param {Record<string, number | null>} scores score of each criterion, null or NaN when it does not apply
 * @param {number} fitness the weighted mean of the scores
 * @param {Record<string, number>} weights
 * @returns {{rows: ScoreRow[], fitness: string}}
 * @example
 * describeScores({...scores, register: 0.976}, 0.9106, weights).rows[1].score // "0.98"
 */
export function describeScores(scores, fitness, weights) {
  const rows = CRITERIA.map((name) => {
    const score = scores[name];
    const applies = score !== null && score !== undefined && !Number.isNaN(score);
    return {
      name,
      label: CRITERION_LABELS[/** @type {keyof typeof CRITERION_LABELS} */ (name)] ?? name,
      weight: String(weights[name]),
      score: applies ? score.toFixed(2) : "not applicable",
      bar: applies ? score : null,
    };
  });
  return { rows, fitness: fitness.toFixed(2) };
}

/** @type {WeakMap<HTMLElement, ReturnType<typeof createVuMeters>>} the meters already built in a container */
const metersOf = new WeakMap();

/**
 * Empty a container of its meters, so the next `renderScores` builds them again (the needles then
 * start parked instead of swinging from another song's scores).
 *
 * @param {HTMLElement} container
 */
export function clearScores(container) {
  metersOf.delete(container);
  container.replaceChildren();
}

/**
 * Show the scores in `container` as VU meters (`vu-meters.js`), one per criterion and one for the
 * fitness. The meters are built the first time and moved after that, so a new run's needles swing
 * from where the last run left them.
 *
 * @param {HTMLElement} container
 * @param {Record<string, number | null>} scores
 * @param {number} fitness
 * @param {Record<string, number>} weights
 */
export function renderScores(container, scores, fitness, weights) {
  let meters = metersOf.get(container);
  if (!meters) {
    meters = createVuMeters(container, weights);
    metersOf.set(container, meters);
  }
  meters.set(scores, fitness);
}
