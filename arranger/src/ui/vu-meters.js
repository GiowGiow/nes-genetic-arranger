// @ts-check
/**
 * VU meters: the fitness criteria as analog needles.
 *
 * The genetic algorithm judges a plan on seven criteria, each scored from 0 (bad) to 1 (good),
 * and the fitness is their weighted mean (`core/fitness.js`). A row of numbers hides which
 * criterion holds a plan back; a row of meters shows it at a glance: the needle that leans least
 * to the right. Each meter is a small old-style VU face (a cream scale with ticks at every
 * quarter and a needle on a pivot) with the criterion's name, its score and its weight under it.
 * An eighth, larger meter shows the fitness. A criterion that does not apply to the song
 * (contrast in a tune without a chorus) has its needle parked left of zero, and drops out of the
 * mean.
 *
 * The needle is one SVG group rotated by a CSS custom property (`--deg`); the browser animates
 * the change with a transition, which only moves `transform`, so it costs nothing on a phone.
 * The meters are built once and updated in place (`createVuMeters`), so during a run the needles
 * glide as the best plan improves instead of jumping.
 *
 * The same panel serves the Evolution view (live scores of the best plan so far) and the Result
 * (the final scores). Each meter is a `role="meter"` figure; the drawing itself is hidden from
 * assistive technology.
 */

import { CRITERIA } from "../core/fitness.js";

/** How far the needle swings either side of upright, in degrees: 0 at the left stop, 1 at the right. */
export const NEEDLE_SWEEP = 50;

/** Where the needle rests when the criterion does not apply: past the zero mark, unmoving. */
export const NEEDLE_PARKED = -58;

/** Criterion names as the settings panel shows them. */
const LABELS = Object.freeze({
  complementarity: "Complementarity",
  register: "Register",
  coherence: "Coherence",
  contrast: "Contrast",
  bass_smoothness: "Bass smoothness",
  idiom: "NES idiom",
  fidelity: "Fidelity",
});

/** The face: a 100 × 60 box, the pivot near the bottom centre, the scale an arc around it. */
const PIVOT = Object.freeze({ x: 50, y: 54 });
const SCALE_RADIUS = 40;
const NEEDLE_LENGTH = 38;

/**
 * The needle's angle for a score.
 *
 * @param {number | null | undefined} score from 0 to 1; null or missing when the criterion does not apply
 * @returns {number} degrees from upright, negative to the left
 * @example
 * needleDegrees(0.75); // 25
 */
export function needleDegrees(score) {
  if (score === null || score === undefined || Number.isNaN(score)) return NEEDLE_PARKED;
  return (Math.min(1, Math.max(0, score)) * 2 - 1) * NEEDLE_SWEEP;
}

/**
 * The scale's ticks: a mark at every quarter, labeled at both ends.
 *
 * @returns {Array<{value: number, x1: number, y1: number, x2: number, y2: number, label: string, lx: number, ly: number}>}
 *   the tick's inner and outer end, and where its label sits, in the face's coordinates
 * @example
 * scaleTicks()[2].value; // 0.5, the upright tick
 */
export function scaleTicks() {
  return [0, 0.25, 0.5, 0.75, 1].map((value) => {
    const angle = (needleDegrees(value) * Math.PI) / 180;
    const at = (/** @type {number} */ radius) => ({
      x: PIVOT.x + Math.sin(angle) * radius,
      y: PIVOT.y - Math.cos(angle) * radius,
    });
    const inner = at(SCALE_RADIUS - (value % 0.5 === 0 ? 5 : 3));
    const outer = at(SCALE_RADIUS);
    const label = at(SCALE_RADIUS + 6.5);
    return {
      value,
      x1: round(inner.x), y1: round(inner.y), x2: round(outer.x), y2: round(outer.y),
      label: value === 0 || value === 1 ? String(value) : "",
      lx: round(label.x), ly: round(label.y),
    };
  });
}

/**
 * What one meter shows.
 * @typedef {object} Reading
 * @property {string} name the criterion's key, or "fitness"
 * @property {string} label
 * @property {number | null} score
 * @property {string} scoreText two decimals, or "n/a"
 * @property {string} weightText for example "weight 1"; empty for the fitness
 * @property {boolean} applies whether the criterion has a score
 * @property {number} degrees the needle's angle
 */

/**
 * The readings of a plan's criterion scores, in the order of the fitness.
 *
 * @param {Record<string, number | null>} scores null or NaN where a criterion does not apply
 * @param {Record<string, number>} weights
 * @returns {Reading[]}
 * @example
 * readings({ ...scores, register: 0.976 }, weights)[1].scoreText; // "0.98"
 */
export function readings(scores, weights) {
  return CRITERIA.map((name) => {
    const raw = scores[name];
    const applies = raw !== null && raw !== undefined && !Number.isNaN(raw);
    return {
      name,
      label: LABELS[/** @type {keyof typeof LABELS} */ (name)] ?? name,
      score: applies ? raw : null,
      scoreText: applies ? raw.toFixed(2) : "n/a",
      weightText: `weight ${weights[name] ?? 0}`,
      applies,
      degrees: needleDegrees(applies ? raw : null),
    };
  });
}

/**
 * The markup of one meter.
 *
 * @param {Reading} reading
 * @param {{big?: boolean}} [options] `big` for the fitness meter
 * @returns {string}
 * @example
 * meterMarkup(readings(scores, weights)[0]); // "<figure class=\"vu\" role=\"meter\" …"
 */
export function meterMarkup(reading, { big = false } = {}) {
  const text = reading.applies ? `${reading.scoreText}${reading.weightText ? `, ${reading.weightText}` : ""}` : "not applicable";
  const value = reading.applies
    ? ` aria-valuenow="${reading.scoreText}"`
    : "";
  const ticks = scaleTicks()
    .map(
      (tick) =>
        `<line x1="${tick.x1}" y1="${tick.y1}" x2="${tick.x2}" y2="${tick.y2}"/>` +
        (tick.label ? `<text x="${tick.lx}" y="${tick.ly}" text-anchor="middle">${tick.label}</text>` : ""),
    )
    .join("");
  const arc = (/** @type {number} */ from, /** @type {number} */ to) => {
    const point = (/** @type {number} */ degrees) => {
      const angle = (degrees * Math.PI) / 180;
      return `${round(PIVOT.x + Math.sin(angle) * SCALE_RADIUS)} ${round(PIVOT.y - Math.cos(angle) * SCALE_RADIUS)}`;
    };
    return `M ${point(from)} A ${SCALE_RADIUS} ${SCALE_RADIUS} 0 0 1 ${point(to)}`;
  };
  return (
    `<figure class="crit${big ? " crit-big" : ""}${reading.applies ? "" : " is-parked"}" role="meter" data-criterion="${reading.name}"` +
    ` aria-label="${reading.label}" aria-valuemin="0" aria-valuemax="1"${value} aria-valuetext="${text}">` +
    `<svg viewBox="0 0 100 60" aria-hidden="true" focusable="false">` +
    `<rect class="crit-face" x="1" y="1" width="98" height="58" rx="5"/>` +
    `<path class="crit-arc" d="${arc(-NEEDLE_SWEEP, NEEDLE_SWEEP)}"/>` +
    `<path class="crit-hot" d="${arc(NEEDLE_SWEEP * 0.6, NEEDLE_SWEEP)}"/>` +
    `<g class="crit-ticks">${ticks}</g>` +
    `<g class="crit-needle" style="--deg: ${reading.degrees}deg"><line x1="${PIVOT.x}" y1="${PIVOT.y + 4}" x2="${PIVOT.x}" y2="${PIVOT.y - NEEDLE_LENGTH}"/></g>` +
    `<circle class="crit-pivot" cx="${PIVOT.x}" cy="${PIVOT.y}" r="3.2"/>` +
    `</svg>` +
    `<figcaption><span class="crit-name">${reading.label}</span>` +
    `<span class="crit-score mono" data-score>${reading.scoreText}</span>` +
    `<span class="crit-weight" data-weight>${reading.weightText}</span></figcaption></figure>`
  );
}

/**
 * The markup of the whole panel: a meter per criterion, then the fitness.
 *
 * @param {Reading[]} rows from `readings`
 * @param {number} fitness the weighted mean
 * @returns {string}
 */
export function metersMarkup(rows, fitness) {
  const total = {
    name: "fitness",
    label: "Fitness",
    score: fitness,
    scoreText: fitness.toFixed(2),
    weightText: "weighted mean",
    applies: true,
    degrees: needleDegrees(fitness),
  };
  return rows.map((row) => meterMarkup(row)).join("") + meterMarkup(total, { big: true });
}

/**
 * Build the panel inside `container`, and return how to move its needles.
 *
 * The meters are made once; `set` only changes each needle's `--deg` and the texts, so the
 * browser's transition swings the needle from where it is to where it goes.
 *
 * @param {HTMLElement} container
 * @param {Record<string, number>} weights the weights to show
 * @returns {{
 *   set: (scores: Record<string, number | null>, fitness: number) => void,
 *   clear: () => void,
 * }} `clear` parks every needle and shows a dash: no run has scored a plan yet
 * @example
 * const meters = createVuMeters(panel, settings.weights);
 * meters.set(message.scores, message.bestFitness); // on every progress message
 */
export function createVuMeters(container, weights) {
  container.classList.add("crit-panel");
  const empty = Object.fromEntries(CRITERIA.map((name) => [name, null]));
  container.innerHTML = metersMarkup(readings(empty, weights), 0);
  container.dataset.waiting = "true";
  /** @type {Map<string, {figure: Element, needle: HTMLElement, score: Element}>} */
  const parts = new Map();
  for (const figure of container.querySelectorAll("[data-criterion]")) {
    parts.set(/** @type {string} */ (figure.getAttribute("data-criterion")), {
      figure,
      needle: /** @type {HTMLElement} */ (figure.querySelector(".crit-needle")),
      score: /** @type {Element} */ (figure.querySelector("[data-score]")),
    });
  }

  /**
   * @param {string} name @param {number | null} score
   * @param {string} scoreText @param {string} valueText
   */
  function show(name, score, scoreText, valueText) {
    const part = parts.get(name);
    if (!part) return;
    const applies = score !== null;
    part.needle.style.setProperty("--deg", `${needleDegrees(score)}deg`);
    part.score.textContent = scoreText;
    part.figure.classList.toggle("is-parked", !applies);
    if (applies) part.figure.setAttribute("aria-valuenow", scoreText);
    else part.figure.removeAttribute("aria-valuenow");
    part.figure.setAttribute("aria-valuetext", valueText);
  }

  return {
    clear() {
      for (const name of parts.keys()) show(name, null, "–", "no score yet");
    },
    set(scores, fitness) {
      for (const row of readings(scores, weights)) {
        show(row.name, row.score, row.scoreText, row.applies ? `${row.scoreText}, ${row.weightText}` : "not applicable");
      }
      show("fitness", fitness, fitness.toFixed(2), `${fitness.toFixed(2)}, weighted mean`);
    },
  };
}

/** @param {number} value */
function round(value) {
  return Math.round(value * 100) / 100;
}
