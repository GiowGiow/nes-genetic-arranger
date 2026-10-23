// @ts-check
/**
 * Evolution lab: the Evolution view as one instrument panel.
 *
 * The genetic algorithm is the point of the app, so the Evolution view shows it as a small lab
 * bench, all of it from the run's own data:
 *
 * - the counters and the oscilloscope (`evolution-view.js`): the generation, how long the best
 *   fitness has stood still, the best fitness, and the fitness curve as a phosphor trace;
 * - one generation, step by step (`generation-strip.js`): the five things every generation does,
 *   with this run's counts and the live numbers;
 * - the fitness criteria on analog meters (`vu-meters.js`), live for the best plan so far;
 * - the best plan so far (`plan-grid.js`), a gene for every bar;
 * - the same plan as a tracker pattern (`tracker-view.js`), the notes the genes make.
 *
 * This module builds those parts, and routes the worker's messages to them. The parts that cost
 * something to redraw (the plan, the pattern, the meters, the strip's numbers) are redrawn when
 * the scope is, a few times a second and only while the view is on screen
 * (`evolution-view.js` paces it), from the latest data kept here.
 */

import { createEvolutionView, screenState } from "./evolution-view.js";
import { createGenerationStrip } from "./generation-strip.js";
import { createPlanGrid } from "./plan-grid.js";
import { createTrackerView } from "./tracker-view.js";
import { createVuMeters } from "./vu-meters.js";

/** @typedef {import("./evolution-view.js").GenerationStats} GenerationStats */

/**
 * Build the lab inside `root` and return its controls.
 *
 * @param {HTMLElement} root the Evolution section
 * @param {object} parts
 * @param {{chartIntervalMs?: number, maxPixelRatio?: number}} [parts.budget] how much to draw
 * @param {Record<string, number>} parts.weights the criteria weights to show on the meters
 * @param {() => void} parts.onStop the visitor pressed Stop
 * @param {() => void} parts.onChooseSong the visitor pressed "Choose a song" on the empty state
 * @returns {{
 *   stopButton: HTMLButtonElement,
 *   setSong: (leadSheet: import("../core/leadsheet.js").LeadSheet | null, limits: {maxGenerations: number, stagnationWindow: number}) => void,
 *   setPlan: (settings: any, leadSheet: import("../core/leadsheet.js").LeadSheet) => void,
 *   begin: (run: {settings: any, leadSheet: import("../core/leadsheet.js").LeadSheet}) => void,
 *   started: (message: any) => void,
 *   progress: (message: any) => void,
 *   finish: (message: any, summary: {stopReason: string, generations: number, durationMs: number}) => void,
 *   show: (run: any) => void,
 *   setScreen: (state: Parameters<typeof screenState>[0]) => void,
 *   last: () => GenerationStats | null,
 * }}
 */
export function createEvolutionLab(root, { budget, weights, onStop, onChooseSong }) {
  const placeholder = root.querySelector(".placeholder");
  placeholder?.remove();
  root.insertAdjacentHTML(
    "beforeend",
    `<div class="empty-state" data-empty-state>
       <p class="empty-title">Pick a song to see the evolution</p>
       <p class="hint">The fitness curve, the steps of each generation and the plan appear here while a run evolves.</p>
       <button type="button" class="button primary" data-choose-song>Choose a song</button>
     </div>
     <div class="lab" data-lab hidden>
       <div class="toolbar evolution-actions">
         <button type="button" class="button" data-stop-evolution disabled>Stop</button>
         <span class="hint">Stop keeps the best plan found so far.</span>
       </div>
       <div data-evolution-view></div>
       <div class="lab-grid">
         <section class="lab-panel" aria-labelledby="lab-steps-title">
           <h3 class="subhead" id="lab-steps-title">One generation, step by step</h3>
           <div data-gen-strip></div>
           <details class="more">
             <summary>How to read the steps</summary>
             <p>Every generation does these five things, in this order. The numbers are this run's:
             the population size, the elite, the pairs of parents, the bar lines a crossover can cut at
             and the mutation rate come from your settings and your song, and the live figures are the
             latest generation the worker reported.</p>
           </details>
         </section>
         <section class="lab-panel" aria-labelledby="lab-meters-title">
           <h3 class="subhead" id="lab-meters-title">Fitness criteria, scored live</h3>
           <div data-live-meters></div>
           <details class="more">
             <summary>How to read the meters</summary>
             <p>Each needle is one criterion of the best plan so far, from 0 at the left to 1 at the
             right; under it, its score and its weight. The fitness is their weighted mean. The needle
             that leans least is what holds the plan back. A parked needle is a criterion that does not
             apply to this song.</p>
           </details>
         </section>
       </div>
       <h3 class="subhead">Best plan so far</h3>
       <div data-plan-grid></div>
       <details class="more">
         <summary>How to read the plan</summary>
         <p>One column per bar. The top row is the chord, named where it changes and
         held until the next tick; a tick without a name is a chord too long for the column. Below it,
         one row per gene: the P2 harmony texture, the TR bass texture, the NO drum pattern and the P1
         melody octave. Brighter cells are busier choices; hover a cell or a chord for its name.</p>
       </details>
       <h3 class="subhead">The same plan as a tracker pattern</h3>
       <div data-tracker></div>
       <details class="more">
         <summary>How to read the pattern</summary>
         <p>NES music was written in trackers: one row for every sixteenth note and one column for
         every channel. P1 is the melody, P2 the harmony, TR the bass (note names, C-4 is middle C)
         and NO the drums: K kick, S snare, H hi-hat. A dot means nothing starts on that row, and a
         plus means more than one note starts in it. Cells that just changed flash.</p>
       </details>
     </div>`,
  );
  const $ = (/** @type {string} */ selector) => /** @type {HTMLElement} */ (root.querySelector(selector));

  const stopButton = /** @type {HTMLButtonElement} */ ($("[data-stop-evolution]"));
  stopButton.addEventListener("click", onStop);
  $("[data-choose-song]").addEventListener("click", onChooseSong);

  const strip = createGenerationStrip($("[data-gen-strip]"));
  const meters = createVuMeters($("[data-live-meters]"), weights);
  const planGrid = createPlanGrid($("[data-plan-grid]"));
  const tracker = createTrackerView($("[data-tracker]"));
  meters.clear();

  /** @type {Uint8Array | null} the newest best plan, drawn at the next paced redraw */
  let latestPlan = null;
  /** @type {Record<string, number | null> | null} */
  let latestScores = null;
  let latestBest = 0;

  const view = createEvolutionView($("[data-evolution-view]"), budget, {
    onPaint(last) {
      if (latestPlan) {
        planGrid.update(latestPlan);
        tracker.update(latestPlan);
      }
      if (latestScores) meters.set(latestScores, latestBest);
      if (last) strip.update(last);
    },
  });

  /**
   * What the strip states about a run.
   * @param {any} settings @param {import("../core/leadsheet.js").LeadSheet} leadSheet @param {Record<string, boolean>} applicable
   */
  function factsFor(settings, leadSheet, applicable) {
    return {
      populationSize: settings.population_size,
      eliteCount: settings.elite_count,
      mutationRate: settings.mutation_rate,
      nBars: leadSheet.bars.length,
      applicable,
    };
  }
  /** The facts of the run in view, so the worker's `started` message can refine them. @type {ReturnType<typeof factsFor> | null} */
  let facts = null;

  /** @param {boolean} hasSong */
  function showLab(hasSong) {
    $("[data-empty-state]").hidden = hasSong;
    $("[data-lab]").hidden = !hasSong;
  }

  return {
    stopButton,
    setSong(leadSheet, limits) {
      showLab(Boolean(leadSheet));
      latestPlan = null;
      latestScores = null;
      meters.clear();
      view.idle(limits);
      if (!leadSheet) return;
      planGrid.setBars(leadSheet.bars);
      tracker.setSong(leadSheet);
    },
    setPlan(settings, leadSheet) {
      // Before any run the steps already say what this song and these settings will do.
      facts = factsFor(settings, leadSheet, facts?.applicable ?? {});
      strip.setRun(facts);
      strip.running(false);
    },
    begin({ settings, leadSheet }) {
      latestPlan = null;
      latestScores = null;
      meters.clear();
      showLab(true);
      planGrid.setBars(leadSheet.bars);
      tracker.setSong(leadSheet);
      facts = factsFor(settings, leadSheet, {});
      strip.setRun(facts);
      strip.running(true);
      view.reset({ maxGenerations: settings.max_generations, stagnationWindow: settings.stagnation_window });
    },
    started(message) {
      // The worker knows which criteria can apply to this song; the strip counts only those.
      if (!facts) return;
      facts = { ...facts, applicable: message.tables?.applicable ?? {} };
      strip.setRun(facts);
      strip.running(true);
    },
    progress(message) {
      view.append(message.generations);
      latestPlan = message.bestPlan;
      latestScores = message.scores ?? null;
      latestBest = message.bestFitness;
    },
    finish(message, summary) {
      latestPlan = message.bestPlan;
      latestScores = message.scores;
      latestBest = message.bestFitness;
      strip.running(false);
      view.finish(summary);
      planGrid.update(message.bestPlan);
      tracker.update(message.bestPlan);
      meters.set(message.scores, message.bestFitness);
    },
    show(run) {
      showLab(true);
      latestPlan = run.message.bestPlan;
      latestScores = run.message.scores;
      latestBest = run.message.bestFitness;
      planGrid.setBars(run.leadSheet.bars);
      tracker.setSong(run.leadSheet);
      facts = factsFor(run.settings, run.leadSheet, run.applicable ?? {});
      strip.setRun(facts);
      strip.running(false);
      view.show(run.log, { maxGenerations: run.settings.max_generations, stagnationWindow: run.settings.stagnation_window });
      view.finish({ stopReason: run.message.stopReason, generations: run.message.generations, durationMs: run.message.durationMs ?? 0 });
      planGrid.update(run.message.bestPlan);
      tracker.update(run.message.bestPlan);
      meters.set(run.message.scores, run.message.bestFitness);
      const last = run.log.at(-1);
      if (last) strip.update(last);
    },
    setScreen: (state) => view.setScreen(screenState(state)),
    last: () => view.last(),
  };

}
