// @ts-check
/**
 * Pacing: how often the page redraws while a run evolves or music plays.
 *
 * A phone has one slow main thread, and the same thread draws the chart, moves the playhead,
 * answers touches and feeds the audio. The genetic algorithm reports twenty times a second and a
 * screen refreshes sixty; neither rate is needed to follow a curve or a playhead, and each draw
 * that is not needed delays a draw that is. Two small rules keep drawing rare:
 *
 * - the pacer folds a burst of "something changed" requests into one draw per interval, and
 *   always draws once more at the end of a burst, so the last state is never left unshown;
 * - the frame gate says whether a frame is worth drawing: only when what it would show changed,
 *   and not sooner than a minimum interval after the last drawn frame.
 *
 * Both are plain functions of a clock, so the tests drive them with a fake one.
 */

/**
 * Run `draw` at most once per `intervalMs`, and once more after the last request.
 *
 * The first request after a quiet interval draws at once; requests inside the interval wait for
 * its end, and many of them cost one draw.
 *
 * @param {() => void} draw what to draw; it reads the current state itself
 * @param {{
 *   intervalMs: number,
 *   now?: () => number,
 *   setTimer?: (run: () => void, delay: number) => any,
 *   clearTimer?: (id: any) => void,
 * }} options the clock and the timer come from outside so a test can drive them
 * @returns {{request: () => void, cancel: () => void}}
 * @example
 * const pacer = createPacer(redrawChart, { intervalMs: 250 });
 * worker.onmessage = () => pacer.request(); // redrawChart runs at most 4 times a second
 */
export function createPacer(draw, { intervalMs, now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
  let lastDrawnAt = -Infinity;
  /** @type {any} */
  let waiting = null;

  function drawNow() {
    waiting = null;
    lastDrawnAt = now();
    draw();
  }

  return {
    request() {
      if (waiting !== null) return; // the draw already waiting will show the latest state
      const wait = lastDrawnAt + intervalMs - now();
      if (wait <= 0) drawNow();
      else waiting = setTimer(drawNow, wait);
    },
    cancel() {
      if (waiting !== null) clearTimer(waiting);
      waiting = null;
    },
  };
}

/**
 * A gate for a drawing loop that runs on every animation frame: it says whether this frame is
 * worth drawing.
 *
 * @param {number} minIntervalMs shortest time between two drawn frames (33 is 30 frames a second)
 * @returns {(now: number, key: unknown, force?: boolean) => boolean} `gate(now, key)` is true when
 *   `key` (what the frame would show) differs from the last drawn frame's and `minIntervalMs` has
 *   passed since it; `force` (a resize, a new scene) draws regardless
 * @example
 * const gate = createFrameGate(33);
 * gate(0, "12.50"); // true: the first frame
 * gate(1000, "12.50"); // false: a paused player looks the same
 */
export function createFrameGate(minIntervalMs) {
  let lastDrawnAt = -Infinity;
  /** @type {unknown} */
  let lastKey = Symbol("nothing drawn yet");
  return (now, key, force = false) => {
    if (!force && (key === lastKey || now - lastDrawnAt < minIntervalMs)) return false;
    lastDrawnAt = now;
    lastKey = key;
    return true;
  };
}

/**
 * How much drawing the page affords: a phone's software canvas and slow main thread get less.
 *
 * - `glow`: the channel view's canvas shadow. A shadow blur costs far more than the stroke it
 *   softens, and a software canvas pays for it on every note dot of every frame;
 * - `maxPixelRatio`: canvases are drawn at most at this device-pixel ratio. A 3x phone screen
 *   would otherwise paint nine times the pixels of a 1x one for lines that are 2 px wide;
 * - `minFrameMs`: the shortest time between two frames of the channel view;
 * - `chartIntervalMs`: the shortest time between two redraws of the evolution chart.
 *
 * @param {boolean} coarse true for a touch screen (`(pointer: coarse)`)
 * @returns {{glow: boolean, maxPixelRatio: number, minFrameMs: number, chartIntervalMs: number}}
 * @example
 * drawingBudget(true).minFrameMs; // 34, about 30 frames a second
 */
export function drawingBudget(coarse) {
  return coarse
    ? { glow: false, maxPixelRatio: 1.5, minFrameMs: 34, chartIntervalMs: 500 }
    : { glow: true, maxPixelRatio: 3, minFrameMs: 0, chartIntervalMs: 250 };
}
