// @ts-check
/**
 * Channel view: the playing version drawn as neon step lines on black (FR-023).
 *
 * It follows the look of the "Bach Vision Test" video. Each pitched channel is a thick line in
 * its color: P1 blue, P2 orange, TR gray. A note is a flat segment, a change of pitch is a jump,
 * a rest is a gap, and a repeated note is a tiny break in the line. The picture scrolls from
 * right to left with the music, and only the head of each line, the note that sounds now, has a
 * dot. The noise channel is a row of small ticks along the bottom. The original shows its
 * melody as a P1 line and its other parts as faint thin dashes. All shapes come from
 * `channel-paths.js`; this file only strokes them.
 *
 * Drawing is the costliest thing the page does while music plays, so it is kept cheap (see
 * `pacing.js`): a frame is drawn only when the playhead moved, the scene changed or the canvas
 * was resized, never while the view is hidden (the Evolution view is open instead), and on a
 * phone at 30 frames a second, at a lower pixel ratio and without the halo. The glow is two
 * strokes of one path, a wide dim one and a thin bright one, because a canvas shadow costs far
 * more than the line it softens. The canvas size comes from a ResizeObserver, so a frame never
 * reads layout, which would force the browser to lay the page out in the middle of the frame.
 */

import {
  drumTicks,
  headNote,
  pitchSpan,
  pitchToY,
  roundedPath,
  stepPolylines,
  timeToX,
  timeWindow,
  visibleSegments,
} from "./channel-paths.js";
import { createFrameGate, drawingBudget } from "./pacing.js";

/**
 * @typedef {{
 *   color: string, notes: Array<{pitch: number, onset: number, duration: number}>,
 *   monophonic: boolean, width?: number, faint?: boolean
 * }} SceneLine notes in seconds; a CSS color or a CSS variable name such as "--p1". A faint line
 *   is drawn as thin dashes in the background (chords and accompaniment); any other line is a step
 *   line, where a later note cuts the earlier one short
 */
/** @typedef {{lines: SceneLine[], drums: number[], label: string}} Scene drums: onsets in seconds */

const WINDOW_SECONDS = 7;
/** Where "now" sits: near the right edge, with a little room for the head dot and its halo. */
const HEAD_FRACTION = 0.84;
const DRUM_BAND = 16;
const TOP_MARGIN = 16;
const CORNER_RADIUS = 6;
/** Pixels of break between two notes of one pitch, on top of the line cap that closes it. */
const REPEAT_GAP = 1.5;
const DRUM_FADE_SECONDS = 1.5;

/** The theme colors, brightened for a black background; other colors are used as given. */
const NEON = new Map([
  ["--p1", "#2fa2ff"],
  ["--p2", "#ff8a1c"],
  ["--tr", "#d3dcef"],
  ["--no", "#ffd23d"],
]);

/**
 * Build the view inside `container`.
 *
 * @param {HTMLElement} container
 * @param {{glow?: boolean, maxPixelRatio?: number, minFrameMs?: number}} [budget] how much to
 *   draw; the default is the page's own, from `drawingBudget`
 * @returns {{setScene: (scene: Scene | null) => void, draw: (t: number) => void}} `draw(t)` may
 *   be called on every animation frame: it draws only when there is something new to show
 */
export function createChannelView(container, budget = drawingBudget(globalThis.matchMedia?.("(pointer: coarse)").matches ?? false)) {
  const { glow = true, maxPixelRatio = 3, minFrameMs = 0 } = budget;
  const canvas = document.createElement("canvas");
  canvas.className = "channel-view";
  canvas.setAttribute("role", "img");
  container.append(canvas);
  /** @type {null | {scene: Scene, lines: Array<{line: SceneLine, notes: SceneLine["notes"]}>, drums: number[], span: {low: number, high: number}}} */
  let prepared = null;
  // The canvas's CSS size, kept by the observer: 0 while the view is hidden, so nothing is drawn.
  let box = { width: 0, height: 0 };
  let needsFrame = true;
  const gate = createFrameGate(minFrameMs);
  /** @type {Map<string, string>} */
  const colors = new Map();
  /** @type {{width: number, gradient: CanvasGradient} | null} */
  let fade = null;
  new ResizeObserver(([entry]) => {
    box = { width: entry.contentRect.width, height: entry.contentRect.height };
    needsFrame = true;
  }).observe(canvas);
  // The theme changes the colors the lines read from the page; read them again, and draw.
  document.addEventListener("themechange", () => {
    colors.clear();
    needsFrame = true;
  });

  /** The color to stroke with: the neon version of a theme color, or the color as given. */
  const color = (/** @type {string} */ value) => {
    if (NEON.has(value)) return /** @type {string} */ (NEON.get(value));
    if (!value.startsWith("--")) return value;
    // The theme colors never change, so each is read from the style once.
    if (!colors.has(value)) colors.set(value, getComputedStyle(canvas).getPropertyValue(value).trim());
    return /** @type {string} */ (colors.get(value));
  };

  return {
    setScene(scene) {
      needsFrame = true;
      if (!scene) {
        prepared = null;
        canvas.setAttribute("aria-label", "No arrangement to show yet");
        return;
      }
      // The path functions expect notes in order of onset; sorting once here keeps frames cheap.
      const lines = scene.lines.map((line) => ({ line, notes: [...line.notes].sort((a, b) => a.onset - b.onset) }));
      prepared = {
        scene,
        lines,
        drums: [...scene.drums].sort((a, b) => a - b),
        // One scale for every voice, so the voices keep their places against each other.
        span: pitchSpan(lines.map(({ notes }) => notes)),
      };
      canvas.setAttribute("aria-label", scene.label);
    },
    draw(t) {
      const { width, height } = box;
      if (!width || !height) return;
      if (!gate(performance.now(), t, needsFrame)) return;
      needsFrame = false;
      const ratio = Math.min(window.devicePixelRatio || 1, maxPixelRatio);
      if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio);
      if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio);
      const context = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.fillStyle = "#000";
      context.fillRect(0, 0, width, height);
      if (!prepared) return;

      const timeframe = timeWindow(t, WINDOW_SECONDS, HEAD_FRACTION);
      const xOf = (/** @type {number} */ time) => timeToX(time, timeframe, width);
      const lane = { top: TOP_MARGIN, bottom: height - DRUM_BAND - 12 };
      const yOf = (/** @type {number} */ pitch) => pitchToY(pitch, /** @type {NonNullable<typeof prepared>} */ (prepared).span, lane);
      const headX = xOf(t);
      context.lineCap = "round";
      context.lineJoin = "round";

      for (const { line, notes } of prepared.lines) {
        const lineColor = color(line.color);
        if (line.faint) {
          // Accompaniment of the original: thin flat dashes that stay out of the way.
          context.strokeStyle = lineColor;
          context.globalAlpha = 0.4;
          context.lineWidth = 1.5;
          context.beginPath();
          for (const { pitch, from, to } of visibleSegments(notes, timeframe.start, t)) {
            context.moveTo(xOf(from), yOf(pitch));
            context.lineTo(xOf(to), yOf(pitch));
          }
          context.stroke();
          context.globalAlpha = 1;
          continue;
        }
        const core = (line.width ?? 2.5) * 1.3;
        const path = new Path2D();
        for (const run of stepPolylines(notes, { xOf, yOf, t, minX: -8, gap: core + REPEAT_GAP })) {
          for (const { op, args } of roundedPath(run, CORNER_RADIUS)) path[op](.../** @type {[number, number, number, number, number]} */ (args));
        }
        context.strokeStyle = lineColor;
        if (glow) {
          context.globalAlpha = 0.17;
          context.lineWidth = core * 3.6;
          context.stroke(path);
        }
        context.globalAlpha = 1;
        context.lineWidth = core;
        context.stroke(path);

        const head = headNote(notes, t);
        if (head) {
          const y = yOf(head.pitch);
          context.fillStyle = lineColor;
          if (glow) {
            context.globalAlpha = 0.3;
            context.beginPath();
            context.arc(headX, y, core * 3, 0, Math.PI * 2);
            context.fill();
            context.globalAlpha = 1;
          }
          context.beginPath();
          context.arc(headX, y, core * 1.15 + 1, 0, Math.PI * 2);
          context.fill();
          context.fillStyle = "#fff";
          context.globalAlpha = 0.85;
          context.beginPath();
          context.arc(headX, y, core * 0.5, 0, Math.PI * 2);
          context.fill();
          context.globalAlpha = 1;
        }
      }

      // The drum lane: small ticks that dim as they age, under a barely visible baseline.
      context.fillStyle = "rgba(255, 255, 255, 0.07)";
      context.fillRect(0, height - DRUM_BAND - 6, width, 1);
      context.fillStyle = color("--no");
      for (const { onset, alpha } of drumTicks(prepared.drums, timeframe.start, t, DRUM_FADE_SECONDS)) {
        const x = xOf(onset);
        if (glow) {
          context.globalAlpha = alpha * 0.2;
          context.fillRect(x - 3, height - DRUM_BAND - 1, 7, DRUM_BAND - 4);
        }
        context.globalAlpha = alpha * 0.85;
        context.fillRect(x - 1, height - DRUM_BAND + 1, 2.5, DRUM_BAND - 8);
      }
      context.globalAlpha = 1;

      // The past leaves to the left by fading out, so a line does not end against the edge.
      if (!fade || fade.width !== width) {
        const gradient = context.createLinearGradient(0, 0, width * 0.14, 0);
        gradient.addColorStop(0, "rgba(0, 0, 0, 1)");
        gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
        fade = { width, gradient };
      }
      context.fillStyle = fade.gradient;
      context.fillRect(0, 0, width * 0.14, height);
    },
  };
}
