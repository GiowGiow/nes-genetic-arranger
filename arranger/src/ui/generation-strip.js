// @ts-check
/**
 * Generation strip: "one generation, step by step", with the numbers of the run on screen.
 *
 * Every generation of the genetic algorithm does the same five things (`core/evolution.js` and
 * `core/operators.js`):
 *
 * 1. Score every plan of the population with the fitness: the weighted mean of the criteria that
 *    apply to the song.
 * 2. Elitism: copy the best few plans unchanged into the next generation, so the best fitness
 *    never goes down.
 * 3. Roulette selection: pick the parents of the other places. A plan's chance is its fitness
 *    above the worst plan's, so better plans are picked more, and the worst never.
 * 4. One-point crossover by bar: cut two parents at the same bar line and swap their tails, so a
 *    child keeps a run of whole bars from each parent.
 * 5. Mutation: each gene of a child changes to another allowed value with a small chance, which
 *    keeps new ideas coming.
 *
 * The strip states each step with the true counts for this run (60 plans, 2 elite, 29 pairs of
 * parents, 31 bar lines to cut at, 1% per gene) and the live numbers from the last generation
 * the worker reported. It adds nothing that the run does not do: the numbers are the settings
 * and arithmetic on them, not an animation of invented values.
 */

import { CRITERIA } from "../core/fitness.js";

/** Genes in a bar: P2 texture, TR texture, NO pattern and P1 octave (`core/genome.js`). */
const GENES_PER_BAR = 4;

/**
 * What the strip needs to know about the run.
 * @typedef {object} RunFacts
 * @property {number} populationSize plans in a generation
 * @property {number} eliteCount plans copied unchanged
 * @property {number} mutationRate chance that each gene of a child changes
 * @property {number} nBars bars in a plan
 * @property {Record<string, boolean>} applicable criteria that can apply to this song, as the
 *   worker's `started` message says (a key is false when the criterion cannot apply)
 */

/**
 * @typedef {object} GenerationStep
 * @property {"score" | "elite" | "select" | "crossover" | "mutate"} id
 * @property {number} number position in the generation, from 1
 * @property {string} title
 * @property {string} text what the step does, with this run's counts
 * @property {Array<{label: string, value: string}>} live numbers from the last reported generation
 */

/**
 * The five steps of a generation, with this run's numbers.
 *
 * @param {RunFacts} run
 * @param {{generation: number, best: number, mean: number, diversity: number, stagnation: number} | null} last
 *   the latest generation reported, or null before the first
 * @returns {GenerationStep[]}
 * @example
 * describeGeneration({ populationSize: 60, eliteCount: 2, mutationRate: 0.01, nBars: 32, applicable: {} }, null)[3].text;
 * // "Cut each of the 29 pairs at one of the 31 bar lines and swap the tails: …"
 */
export function describeGeneration(run, last) {
  const { populationSize: m, eliteCount: elite, mutationRate: rate, nBars } = run;
  const children = m - elite;
  const pairs = Math.ceil(children / 2);
  const cuts = Math.max(0, nBars - 1);
  const criteria = CRITERIA.length - Object.values(run.applicable).filter((applies) => applies === false).length;
  const perBar = (1 - (1 - rate) ** GENES_PER_BAR) * 100;
  const changed = Math.round(children * nBars * GENES_PER_BAR * rate);
  const number = (/** @type {number} */ value) => value.toLocaleString("en-US");
  const percent = (/** @type {number} */ value) => `${Number(value.toFixed(1))}%`;
  const count = (/** @type {number} */ value, /** @type {string} */ one, /** @type {string} */ many) =>
    `${number(value)} ${value === 1 ? one : many}`;

  /** @type {GenerationStep[]} */
  const steps = [
    {
      id: "score",
      number: 1,
      title: "Score",
      text: `Score all ${count(m, "plan", "plans")} on ${count(criteria, "criterion", "criteria")}: the fitness is their weighted mean.`,
      live: last ? [{ label: "plans scored", value: number((last.generation + 1) * m) }] : [],
    },
    {
      id: "elite",
      number: 2,
      title: "Keep the elite",
      text: `Copy the best ${elite} of ${m} unchanged, so the best fitness never drops.`,
      live: last
        ? [{ label: "best fitness", value: last.best.toFixed(4) }, ...(last.stagnation > 0 ? [{ label: "without improvement", value: String(last.stagnation) }] : [])]
        : [],
    },
    {
      id: "select",
      number: 3,
      title: "Roulette",
      text: `Fill the other ${count(children, "place", "places")} with ${count(children, "child", "children")}. Pick ${count(2 * pairs, "parent", "parents")}, each with a chance in proportion to its fitness above the worst plan's.`,
      live: last
        ? [{ label: "population mean", value: last.mean.toFixed(4) }, { label: "distinct plans", value: `${Math.round(last.diversity * 100)}%` }]
        : [],
    },
    {
      id: "crossover",
      number: 4,
      title: "Crossover",
      text:
        cuts > 0
          ? `Cut each of the ${count(pairs, "pair", "pairs")} at one of the ${count(cuts, "bar line", "bar lines")} and swap the tails: a child keeps whole bars from each parent.`
          : `The song has no bar line to cut at, so the ${count(pairs, "pair", "pairs")} are copied.`,
      live: [],
    },
    {
      id: "mutate",
      number: 5,
      title: "Mutate",
      text: `Each gene changes with a chance of ${percent(rate * 100)} per gene, about ${percent(perBar)} per bar (4 genes: P2, TR, NO, octave).`,
      live: [{ label: "genes changed per generation", value: `about ${number(changed)}` }],
    },
  ];
  return steps;
}

/**
 * The steps as an ordered list.
 *
 * @param {GenerationStep[]} steps
 * @returns {string}
 */
export function stepsMarkup(steps) {
  const items = steps
    .map(
      (step) =>
        `<li class="gen-step" style="--i: ${step.number - 1}"><span class="gen-num mono" aria-hidden="true">${step.number}</span>` +
        `<div><strong class="gen-title">${step.title}</strong><p class="gen-text">${step.text}</p>` +
        `<dl class="gen-live" data-live="${step.id}">${step.live
          .map((item) => `<div><dt>${item.label}</dt><dd class="mono">${item.value}</dd></div>`)
          .join("")}</dl></div></li>`,
    )
    .join("");
  return `<ol class="gen-steps" aria-label="The steps of one generation">${items}</ol>`;
}

/**
 * Build the strip inside `container`.
 *
 * @param {HTMLElement} container
 * @returns {{
 *   setRun: (run: RunFacts) => void,
 *   update: (last: {generation: number, best: number, mean: number, diversity: number, stagnation: number}) => void,
 *   running: (on: boolean) => void,
 * }}
 * @example
 * const strip = createGenerationStrip(host);
 * strip.setRun({ populationSize: 60, eliteCount: 2, mutationRate: 0.01, nBars: 32, applicable });
 * strip.update(lastGeneration); // on each paced redraw
 */
export function createGenerationStrip(container) {
  container.classList.add("gen-strip");
  /** @type {RunFacts | null} */
  let facts = null;
  /** @type {Map<string, HTMLElement>} */
  let live = new Map();
  let lastMarkup = "";

  function build(/** @type {any} */ last) {
    if (!facts) return;
    const markup = stepsMarkup(describeGeneration(facts, last));
    if (markup === lastMarkup) return;
    // The whole list is set again only when the text changes; the numbers change every redraw,
    // so they are written into their own elements instead (see `update`).
    container.innerHTML = markup;
    lastMarkup = markup;
    live = new Map([...container.querySelectorAll("[data-live]")].map((element) => [/** @type {string} */ (element.getAttribute("data-live")), /** @type {HTMLElement} */ (element)]));
  }

  return {
    setRun(run) {
      facts = run;
      lastMarkup = "";
      build(null);
    },
    update(last) {
      if (!facts) return;
      const steps = describeGeneration(facts, last);
      for (const step of steps) {
        const element = live.get(step.id);
        if (!element) continue;
        const html = step.live.map((item) => `<div><dt>${item.label}</dt><dd class="mono">${item.value}</dd></div>`).join("");
        if (element.innerHTML !== html) element.innerHTML = html;
      }
    },
    running(on) {
      container.classList.toggle("is-running", on);
    },
  };
}
