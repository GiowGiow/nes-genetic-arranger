// @ts-check
/**
 * Evolution view: the fitness curve and the two stopping counters, drawn while the GA runs.
 *
 * Every generation of the genetic algorithm has a best plan and a population mean. The curve
 * shows both: the best line climbs in steps (elitism keeps the best plan, so it never goes down)
 * and the mean line follows it as selection fills the population with copies of good plans. Two
 * counters show why a run stops: the generation counter against the maximum, and the stagnation
 * counter, the generations since the best fitness last improved, against its window. The page
 * figure of the command line's `evolution.png` (`src/export/figures.py`) shows the same curves
 * after a run; here they grow live from the worker's `progress` messages
 * (contracts/worker-protocol.md).
 *
 * The worker reports about twenty times a second, but a curve is followed at a few frames a
 * second, so redraws are paced (`pacing.js`): a burst of messages costs one redraw, and the last
 * message always gets its redraw. While the Evolution view is not the visible one (the Result
 * view is open, or another page tab) nothing is drawn; the canvas size, kept by a ResizeObserver,
 * is 0 then, and the observer asks for a redraw when the view comes back. The chart's canvas is
 * resized only when its size changes, because assigning `canvas.width` reallocates the bitmap.
 */

import { createPacer, drawingBudget } from "./pacing.js";

/** @typedef {{generation: number, best: number, mean: number, diversity: number, stagnation: number}} GenerationStats */

/**
 * Build the view inside `container` and return its controls.
 *
 * @param {HTMLElement} container element that receives the chart, the counters and the caption
 * @param {{chartIntervalMs?: number, maxPixelRatio?: number}} [budget] how much to draw; the
 *   default is the page's own, from `drawingBudget`
 * @returns {{
 *   reset: (limits: {maxGenerations: number, stagnationWindow: number}) => void,
 *   append: (generations: GenerationStats[]) => void,
 *   show: (log: GenerationStats[], limits: {maxGenerations: number, stagnationWindow: number}) => void,
 *   finish: (summary: {stopReason: string, generations: number, durationMs: number}) => void,
 * }}
 */
export function createEvolutionView(container, budget = drawingBudget(globalThis.matchMedia?.("(pointer: coarse)").matches ?? false)) {
  const { chartIntervalMs = 250, maxPixelRatio = 3 } = budget;
  container.innerHTML = `
    <div class="counters">
      <div class="counter"><span class="label">Generation</span>
        <span class="value mono" data-generation>0 / 0</span>
        <span class="meter"><span data-generation-bar></span></span></div>
      <div class="counter"><span class="label">Without improvement</span>
        <span class="value mono" data-stagnation>0 / 0</span>
        <span class="meter stagnation"><span data-stagnation-bar></span></span></div>
      <div class="counter"><span class="label">Best fitness</span>
        <span class="value mono" data-best>–</span>
        <span class="status" data-status>Waiting for a run</span></div>
    </div>
    <canvas class="chart" data-chart role="img"
      aria-label="Fitness per generation: best and mean of the population"></canvas>
    <p class="caption">Best fitness (blue) and population mean (gray) per generation. The best line
    only climbs, because the best plans pass unchanged to the next generation (elitism). The run
    stops when the counter "without improvement" fills its window, or at the maximum.</p>`;
  const $ = (/** @type {string} */ selector) =>
    /** @type {HTMLElement} */ (container.querySelector(selector));
  const canvas = /** @type {HTMLCanvasElement} */ ($("[data-chart]"));
  /** @type {GenerationStats[]} */
  let log = [];
  let limits = { maxGenerations: 1, stagnationWindow: 1 };
  // The canvas's CSS size, from the observer: 0 while the view is hidden.
  let box = { width: 0, height: 0 };

  function redraw() {
    if (box.width === 0 || box.height === 0) return; // hidden: the observer redraws when it shows
    const last = log.at(-1);
    if (last) {
      $("[data-generation]").textContent = `${last.generation} / ${limits.maxGenerations}`;
      $("[data-stagnation]").textContent = `${last.stagnation} / ${limits.stagnationWindow}`;
      $("[data-best]").textContent = last.best.toFixed(4);
      setBar($("[data-generation-bar]"), last.generation / limits.maxGenerations);
      setBar($("[data-stagnation-bar]"), last.stagnation / limits.stagnationWindow);
    }
    drawChart(canvas, box, Math.min(window.devicePixelRatio || 1, maxPixelRatio), log);
  }

  const pacer = createPacer(redraw, { intervalMs: chartIntervalMs });
  const schedule = () => pacer.request();

  new ResizeObserver(([entry]) => {
    box = { width: entry.contentRect.width, height: entry.contentRect.height };
    // A resize or a return from hidden must show the chart now, not at the next paced redraw.
    redraw();
  }).observe(canvas);

  return {
    reset(newLimits) {
      limits = newLimits;
      log = [];
      $("[data-status]").textContent = "Evolving…";
      $("[data-best]").textContent = "–";
      $("[data-generation]").textContent = `0 / ${limits.maxGenerations}`;
      $("[data-stagnation]").textContent = `0 / ${limits.stagnationWindow}`;
      setBar($("[data-generation-bar]"), 0);
      setBar($("[data-stagnation-bar]"), 0);
      schedule();
    },
    append(generations) {
      log.push(...generations);
      schedule();
    },
    show(fullLog, newLimits) {
      limits = newLimits;
      log = [...fullLog];
      schedule();
    },
    finish({ stopReason, generations, durationMs }) {
      const reasons = {
        stagnation: "stopped by stagnation",
        max_generations: "reached the maximum",
        stopped: "stopped by you",
      };
      const reason = reasons[/** @type {keyof typeof reasons} */ (stopReason)] ?? stopReason;
      $("[data-status]").textContent =
        `${generations} generations, ${reason}, in ${(durationMs / 1000).toFixed(1)} s`;
      schedule();
    },
  };
}

/**
 * @param {HTMLElement} bar
 * @param {number} share from 0 to 1
 */
function setBar(bar, share) {
  // A transform is moved by the compositor; animating `width` would lay the page out again.
  bar.style.transform = `scaleX(${Math.max(0, Math.min(1, share))})`;
}

/**
 * Draw best and mean fitness against the generation, scaled to the canvas size.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{width: number, height: number}} box the canvas's CSS size
 * @param {number} ratio device pixels per CSS pixel to draw at
 * @param {GenerationStats[]} log
 */
function drawChart(canvas, { width, height }, ratio, log) {
  if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio);
  if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio);
  const context = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const style = getComputedStyle(canvas);
  const color = (/** @type {string} */ name) => style.getPropertyValue(name).trim();

  const pad = { left: 44, right: 10, top: 10, bottom: 24 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const lastGeneration = Math.max(50, log.at(-1)?.generation ?? 0);
  const low = log.length ? Math.min(...log.map((entry) => entry.mean)) : 0;
  const yMin = Math.max(0, Math.floor(low * 10) / 10 - 0.05);
  const yMax = 1;
  const x = (/** @type {number} */ generation) => pad.left + (generation / lastGeneration) * plotWidth;
  const y = (/** @type {number} */ value) =>
    pad.top + (1 - (value - yMin) / (yMax - yMin)) * plotHeight;

  context.font = `11px ${color("--mono")}`;
  context.fillStyle = color("--muted");
  context.strokeStyle = color("--line");
  context.lineWidth = 1;
  for (let tick = 0; tick <= 4; tick += 1) {
    const value = yMin + ((yMax - yMin) * tick) / 4;
    context.beginPath();
    context.moveTo(pad.left, y(value));
    context.lineTo(width - pad.right, y(value));
    context.stroke();
    context.fillText(value.toFixed(2), 4, y(value) + 4);
  }
  context.fillText("0", pad.left, height - 6);
  const lastLabel = String(lastGeneration);
  context.fillText(lastLabel, width - pad.right - context.measureText(lastLabel).width, height - 6);

  if (log.length < 2) return;
  // Long runs have thousands of generations: one point per pixel column is enough.
  const step = Math.max(1, Math.floor(log.length / plotWidth));
  for (const [key, name, lineWidth] of /** @type {const} */ ([
    ["mean", "--muted", 1.5],
    ["best", "--p1", 2.5],
  ])) {
    context.strokeStyle = color(name);
    context.lineWidth = lineWidth;
    context.beginPath();
    for (let index = 0; index < log.length; index += step) {
      const entry = log[index];
      if (index === 0) context.moveTo(x(entry.generation), y(entry[key]));
      else context.lineTo(x(entry.generation), y(entry[key]));
    }
    const last = /** @type {GenerationStats} */ (log.at(-1));
    context.lineTo(x(last.generation), y(last[key]));
    context.stroke();
  }
}
