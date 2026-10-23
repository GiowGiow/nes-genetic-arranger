// @ts-check
/**
 * Evolution view: the counters and the oscilloscope, drawn while the GA runs.
 *
 * Every generation of the genetic algorithm has a best plan and a population mean. The scope
 * shows both: the best trace climbs in steps (elitism keeps the best plan, so it never goes down)
 * and the mean trace follows it as selection fills the population with copies of good plans. The
 * data is the run's own: nothing is smoothed or invented. Only the look is a lab instrument's:
 * the generation count is a mechanical counter (digit wheels that roll), and the fitness curve is
 * drawn as a phosphor trace on a dark graticule, with a faint sweep over the screen while the run
 * goes. The scope's colors belong to the instrument, not to the page theme: a green trace on a
 * black screen reads the same in the dark and the light theme.
 *
 * Two counters show why a run stops: the generation counter against the maximum, and the
 * stagnation counter, the generations since the best fitness last improved, against its window.
 * The command line's `evolution.png` (`src/export/figures.py`) shows the same curves after a
 * run; here they grow live from the worker's `progress` messages (contracts/worker-protocol.md).
 *
 * Before a run, the scope's screen says INSERT COIN, blinking, like an arcade machine waiting for
 * a player; while the run starts (the worker loads, the first generation is computed) it blinks
 * faster, and the counters shimmer. `screenState` decides which.
 *
 * The worker reports about twenty times a second, but a curve is followed at a few frames a
 * second, so redraws are paced (`pacing.js`): a burst of messages costs one redraw, and the last
 * message always gets its redraw. While the Evolution view is not the visible one (the Result
 * view is open, or another page tab) nothing is drawn; the canvas size, kept by a ResizeObserver,
 * is 0 then, and the observer asks for a redraw when the view comes back. The scope's canvas is
 * resized only when its size changes, because assigning `canvas.width` reallocates the bitmap.
 */

import { createPacer, drawingBudget } from "./pacing.js";

/** @typedef {{generation: number, best: number, mean: number, diversity: number, stagnation: number}} GenerationStats */

/**
 * The digit wheels of a mechanical counter.
 *
 * @param {number} value a whole number, 0 or more
 * @param {number} width how many wheels the counter has; a larger number shows its last digits
 * @returns {Array<{char: string, dim: boolean}>} one entry per wheel; the zeros before the first
 *   digit of the number are dim, so the counter reads as "0007" with the 7 lit
 * @example
 * counterDigits(7, 4).map((digit) => digit.char).join(""); // "0007"
 */
export function counterDigits(value, width) {
  const text = String(Math.max(0, Math.floor(value))).padStart(width, "0").slice(-width);
  const lit = text.search(/[1-9]/);
  const first = lit === -1 ? width - 1 : lit;
  return [...text].map((char, index) => ({ char, dim: index < first }));
}

/**
 * The markup of a counter, for the first draw.
 *
 * @param {Array<{char: string, dim: boolean}>} digits
 * @param {string} label what a screen reader hears instead of the wheels, for example "Generation 42"
 * @returns {string}
 */
export function counterMarkup(digits, label) {
  const wheels = digits
    .map((digit) => `<span class="wheel mono${digit.dim ? " is-dim" : ""}${digit.char === "." ? " is-dot" : ""}">${digit.char}</span>`)
    .join("");
  return `<span class="odometer" role="img" aria-label="${label}">${wheels}</span>`;
}

/**
 * The scope's vertical range: from a tenth below the lowest mean (never below 0) to 1.
 *
 * @param {number[]} means the mean fitness of the generations so far
 * @returns {{yMin: number, yMax: number}}
 * @example
 * scopeAxis([0.52, 0.8]); // { yMin: 0.45, yMax: 1 }
 */
export function scopeAxis(means) {
  if (means.length === 0) return { yMin: 0, yMax: 1 };
  const low = means.reduce((lowest, mean) => Math.min(lowest, mean), Infinity);
  return { yMin: Math.max(0, Math.round((Math.floor(low * 10) / 10 - 0.05) * 100) / 100), yMax: 1 };
}

/**
 * What the scope's screen says.
 *
 * @param {{hasSong: boolean, running: boolean, generations: number, hasRun: boolean}} state
 *   `generations`: how many generations the screen has received; `hasRun`: a run has put data on it
 * @returns {{coin: boolean, blink: "none" | "slow" | "fast", message: string}} `coin`: show
 *   INSERT COIN; `blink`: how fast it blinks; `message`: the line under it
 * @example
 * screenState({ hasSong: true, running: true, generations: 0, hasRun: false }).blink; // "fast"
 */
export function screenState({ hasSong, running, generations, hasRun }) {
  if (!hasSong) return { coin: false, blink: "none", message: "Pick a song to see the evolution" };
  if (running && generations === 0) return { coin: true, blink: "fast", message: "Starting the evolution…" };
  if (!hasRun && !running) return { coin: true, blink: "slow", message: "Press Arrange to start" };
  return { coin: false, blink: "none", message: "" };
}

/**
 * Build the view inside `container` and return its controls.
 *
 * @param {HTMLElement} container element that receives the counters, the scope and the caption
 * @param {{chartIntervalMs?: number, maxPixelRatio?: number}} [budget] how much to draw; the
 *   default is the page's own, from `drawingBudget`
 * @param {{onPaint?: (last: GenerationStats | null) => void}} [hooks] `onPaint` runs after each
 *   paced redraw, so the parts around the scope update at the same rate
 * @returns {{
 *   reset: (limits: {maxGenerations: number, stagnationWindow: number}) => void,
 *   append: (generations: GenerationStats[]) => void,
 *   show: (log: GenerationStats[], limits: {maxGenerations: number, stagnationWindow: number}) => void,
 *   finish: (summary: {stopReason: string, generations: number, durationMs: number}) => void,
 *   idle: (limits: {maxGenerations: number, stagnationWindow: number}) => void,
 *   setScreen: (state: ReturnType<typeof screenState>) => void,
 *   last: () => GenerationStats | null,
 * }}
 */
export function createEvolutionView(container, budget = drawingBudget(globalThis.matchMedia?.("(pointer: coarse)").matches ?? false), hooks = {}) {
  const { chartIntervalMs = 250, maxPixelRatio = 3 } = budget;
  container.innerHTML = `
    <div class="counters">
      <div class="counter"><span class="label">Generation</span>
        <span class="counter-row" data-generation>${counterMarkup(counterDigits(0, 4), "Generation 0")}<span class="of mono" data-generation-of>/ 0</span></span>
        <span class="meter"><span data-generation-bar></span></span></div>
      <div class="counter"><span class="label">Without improvement</span>
        <span class="counter-row" data-stagnation>${counterMarkup(counterDigits(0, 3), "Without improvement 0")}<span class="of mono" data-stagnation-of>/ 0</span></span>
        <span class="meter stagnation"><span data-stagnation-bar></span></span></div>
      <div class="counter"><span class="label">Best fitness</span>
        <span class="counter-row" data-best>${counterMarkup([..."0.0000"].map((char) => ({ char, dim: true })), "Best fitness not known yet")}</span>
        <span class="status" data-status>Waiting for a run</span></div>
    </div>
    <div class="scope" data-scope>
      <canvas class="chart" data-chart role="img"
        aria-label="Fitness per generation: best and mean of the population"></canvas>
      <div class="scope-screen" data-screen>
        <p class="coin mono" data-coin hidden>INSERT COIN</p>
        <p class="coin-message mono" data-coin-message></p>
      </div>
    </div>
    <details class="more">
      <summary>How to read the scope</summary>
      <p>Best fitness (bright green) and population mean (dim green) per generation. The best trace
      only climbs, because the best plans pass unchanged to the next generation (elitism). The run
      stops when the counter "without improvement" fills its window, or at the maximum.</p>
    </details>`;
  const $ = (/** @type {string} */ selector) =>
    /** @type {HTMLElement} */ (container.querySelector(selector));
  const canvas = /** @type {HTMLCanvasElement} */ ($("[data-chart]"));
  /** @type {GenerationStats[]} */
  let log = [];
  let limits = { maxGenerations: 1, stagnationWindow: 1 };
  // The canvas's CSS size, from the observer: 0 while the view is hidden.
  let box = { width: 0, height: 0 };

  /**
   * Set a counter's wheels, rolling only the wheels whose digit changed.
   * @param {string} selector the counter row
   * @param {Array<{char: string, dim: boolean}>} digits
   * @param {string} label
   */
  function setCounter(selector, digits, label) {
    const odometer = $(`${selector} .odometer`);
    odometer.setAttribute("aria-label", label);
    const wheels = odometer.children;
    digits.forEach((digit, index) => {
      const wheel = /** @type {HTMLElement | undefined} */ (wheels[index]);
      if (!wheel) return;
      if (wheel.textContent !== digit.char) {
        wheel.textContent = digit.char;
        // Two identical animations take turns, so the roll restarts without forcing a reflow.
        wheel.dataset.tick = wheel.dataset.tick === "0" ? "1" : "0";
      }
      wheel.classList.toggle("is-dim", digit.dim);
    });
  }

  function paintCounters(/** @type {GenerationStats | undefined} */ last) {
    const generation = last?.generation ?? 0;
    const stagnation = last?.stagnation ?? 0;
    setCounter("[data-generation]", counterDigits(generation, 4), `Generation ${generation} of ${limits.maxGenerations}`);
    setCounter("[data-stagnation]", counterDigits(stagnation, 3), `${stagnation} generations without improvement, of ${limits.stagnationWindow}`);
    if (last) {
      setCounter("[data-best]", [..."0.0000"].map((_, index) => ({ char: last.best.toFixed(4)[index], dim: false })), `Best fitness ${last.best.toFixed(4)}`);
    }
    $("[data-generation-of]").textContent = `/ ${limits.maxGenerations}`;
    $("[data-stagnation-of]").textContent = `/ ${limits.stagnationWindow}`;
    setBar($("[data-generation-bar]"), generation / limits.maxGenerations);
    setBar($("[data-stagnation-bar]"), stagnation / limits.stagnationWindow);
  }

  function redraw() {
    if (box.width === 0 || box.height === 0) return; // hidden: the observer redraws when it shows
    const last = log.at(-1);
    paintCounters(last);
    drawScope(canvas, box, Math.min(window.devicePixelRatio || 1, maxPixelRatio), log);
    hooks.onPaint?.(last ?? null);
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
      setCounter("[data-best]", [..."0.0000"].map((char) => ({ char, dim: true })), "Best fitness not known yet");
      container.classList.add("is-running");
      schedule();
    },
    append(generations) {
      log.push(...generations);
      schedule();
    },
    idle(newLimits) {
      // A new song: nothing of the last run's curve may stay on the screen.
      limits = newLimits;
      log = [];
      $("[data-status]").textContent = "Waiting for a run";
      setCounter("[data-best]", [..."0.0000"].map((char) => ({ char, dim: true })), "Best fitness not known yet");
      container.classList.remove("is-running");
      schedule();
    },
    show(fullLog, newLimits) {
      limits = newLimits;
      log = [...fullLog];
      container.classList.remove("is-running");
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
      container.classList.remove("is-running");
      schedule();
    },
    setScreen({ coin, blink, message }) {
      $("[data-coin]").hidden = !coin;
      $("[data-coin]").dataset.blink = blink;
      $("[data-coin-message]").textContent = message;
      container.classList.toggle("is-waiting", coin);
      container.classList.toggle("is-starting", coin && blink === "fast");
      container.setAttribute("aria-busy", String(coin && blink === "fast"));
    },
    last: () => log.at(-1) ?? null,
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

/** The instrument's own colors: a black glass screen and a green phosphor. */
const SCOPE = Object.freeze({
  glass: "#04100a",
  graticule: "rgba(90, 255, 150, .13)",
  axis: "rgba(90, 255, 150, .30)",
  label: "rgba(130, 255, 180, .62)",
  best: "#5dff9c",
  bestGlow: "rgba(93, 255, 156, .22)",
  mean: "rgba(93, 255, 156, .5)",
  beam: "rgba(200, 255, 220, .85)",
});

/**
 * Draw best and mean fitness against the generation as an oscilloscope trace, scaled to the
 * canvas size.
 *
 * The graticule is the usual ten divisions across and four up, with finer ticks on the middle
 * lines. The trace is two strokes of one path, a wide dim one for the glow and a thin bright one
 * for the line (a canvas shadow would cost far more), and a bright dot marks the beam's head, the
 * latest generation.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{width: number, height: number}} box the canvas's CSS size
 * @param {number} ratio device pixels per CSS pixel to draw at
 * @param {GenerationStats[]} log
 */
function drawScope(canvas, { width, height }, ratio, log) {
  if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio);
  if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio);
  const context = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.fillStyle = SCOPE.glass;
  context.fillRect(0, 0, width, height);
  const mono = getComputedStyle(canvas).getPropertyValue("--mono").trim() || "monospace";

  const pad = { left: 44, right: 12, top: 12, bottom: 24 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const lastGeneration = Math.max(50, log.at(-1)?.generation ?? 0);
  const { yMin, yMax } = scopeAxis(log.map((entry) => entry.mean));
  const x = (/** @type {number} */ generation) => pad.left + (generation / lastGeneration) * plotWidth;
  const y = (/** @type {number} */ value) => pad.top + (1 - (value - yMin) / (yMax - yMin)) * plotHeight;

  // Graticule: 10 columns and 4 rows; the middle lines are brighter, with a tick every fifth of a division.
  context.lineWidth = 1;
  for (let column = 0; column <= 10; column += 1) {
    const gx = Math.round(pad.left + (plotWidth * column) / 10) + 0.5;
    context.strokeStyle = column === 5 ? SCOPE.axis : SCOPE.graticule;
    context.beginPath();
    context.moveTo(gx, pad.top);
    context.lineTo(gx, pad.top + plotHeight);
    context.stroke();
  }
  context.font = `11px ${mono}`;
  context.fillStyle = SCOPE.label;
  for (let row = 0; row <= 4; row += 1) {
    const gy = Math.round(pad.top + (plotHeight * row) / 4) + 0.5;
    context.strokeStyle = row === 2 ? SCOPE.axis : SCOPE.graticule;
    context.beginPath();
    context.moveTo(pad.left, gy);
    context.lineTo(width - pad.right, gy);
    context.stroke();
    const value = yMax - ((yMax - yMin) * row) / 4;
    context.fillText(value.toFixed(2), 6, gy + 4);
  }
  context.strokeStyle = SCOPE.axis;
  context.beginPath();
  const midY = Math.round(pad.top + plotHeight / 2) + 0.5;
  for (let tick = 0; tick <= 50; tick += 1) {
    const tx = pad.left + (plotWidth * tick) / 50;
    context.moveTo(tx, midY - (tick % 5 === 0 ? 4 : 2));
    context.lineTo(tx, midY + (tick % 5 === 0 ? 4 : 2));
  }
  context.stroke();
  context.fillStyle = SCOPE.label;
  context.fillText("0", pad.left, height - 8);
  const lastLabel = `generation ${lastGeneration}`;
  context.fillText(lastLabel, width - pad.right - context.measureText(lastLabel).width, height - 8);

  if (log.length < 2) return;
  // Long runs have thousands of generations: one point per pixel column is enough.
  const step = Math.max(1, Math.floor(log.length / plotWidth));
  const last = /** @type {GenerationStats} */ (log.at(-1));
  context.save();
  context.beginPath();
  context.rect(pad.left, pad.top - 2, plotWidth + 4, plotHeight + 4);
  context.clip();
  context.lineJoin = "round";
  for (const [key, color, lineWidth, glow] of /** @type {const} */ ([
    ["mean", SCOPE.mean, 1.25, false],
    ["best", SCOPE.best, 1.75, true],
  ])) {
    const path = new Path2D();
    for (let index = 0; index < log.length; index += step) {
      const entry = log[index];
      if (index === 0) path.moveTo(x(entry.generation), y(entry[key]));
      else path.lineTo(x(entry.generation), y(entry[key]));
    }
    path.lineTo(x(last.generation), y(last[key]));
    if (glow) {
      context.strokeStyle = SCOPE.bestGlow;
      context.lineWidth = 6;
      context.stroke(path);
    }
    context.strokeStyle = color;
    context.lineWidth = lineWidth;
    context.stroke(path);
  }
  // The beam's head: a bright dot with a halo at the newest generation.
  context.fillStyle = SCOPE.bestGlow;
  context.beginPath();
  context.arc(x(last.generation), y(last.best), 6, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = SCOPE.beam;
  context.beginPath();
  context.arc(x(last.generation), y(last.best), 2, 0, Math.PI * 2);
  context.fill();
  context.restore();
}
