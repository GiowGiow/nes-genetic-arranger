// @ts-check
/**
 * Channel view: the playing version drawn as glowing lines that the playhead reveals (FR-023).
 *
 * The arrangement shows one step line per pitched channel in its color (P1 blue, P2 orange,
 * TR gray), with a dot where each note starts, and the noise channel as ticks along the bottom; the original shows its melody in the
 * P1 color and the other parts as faint dashes. The window scrolls with the playhead, like the
 * command line's video (`src/export/video.py`), so what you see is what you hear.
 *
 * Drawing is the costliest thing the page does while music plays, so it is kept cheap (see
 * `pacing.js`): a frame is drawn only when the playhead moved, the scene changed or the canvas
 * was resized, never while the view is hidden (the Evolution view is open instead), and on a
 * phone at 30 frames a second, at a lower pixel ratio and without the canvas glow. The canvas
 * size comes from a ResizeObserver, so a frame never reads layout, which would force the browser
 * to lay the page out in the middle of the frame.
 */

import { soundingPitch, stepLine, visibleUntil } from "./channel-paths.js";
import { createFrameGate, drawingBudget } from "./pacing.js";

/**
 * @typedef {{
 *   color: string, notes: Array<{pitch: number, onset: number, duration: number}>,
 *   monophonic: boolean, width?: number, faint?: boolean
 * }} SceneLine notes in seconds; a CSS color or a CSS variable name such as "--p1"
 */
/** @typedef {{lines: SceneLine[], drums: number[], label: string}} Scene drums: onsets in seconds */

const WINDOW_SECONDS = 8;
const DRUM_BAND = 18;

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
  /** @type {null | {scene: Scene, paths: Array<{line: SceneLine, path: import("./channel-paths.js").StepLine}>, low: number, high: number}} */
  let prepared = null;
  // The canvas's CSS size, kept by the observer: 0 while the view is hidden, so nothing is drawn.
  let box = { width: 0, height: 0 };
  let needsFrame = true;
  const gate = createFrameGate(minFrameMs);
  /** @type {Map<string, string>} */
  const colors = new Map();
  new ResizeObserver(([entry]) => {
    box = { width: entry.contentRect.width, height: entry.contentRect.height };
    needsFrame = true;
  }).observe(canvas);

  return {
    setScene(scene) {
      needsFrame = true;
      if (!scene) {
        prepared = null;
        canvas.setAttribute("aria-label", "No arrangement to show yet");
        return;
      }
      const pitches = scene.lines.flatMap((line) => line.notes.map((note) => note.pitch));
      prepared = {
        scene,
        paths: scene.lines.map((line) => ({ line, path: stepLine(line.notes) })),
        low: (pitches.length ? Math.min(...pitches) : 48) - 3,
        high: (pitches.length ? Math.max(...pitches) : 84) + 3,
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
      context.clearRect(0, 0, width, height);
      if (!prepared) return;
      // The theme colors never change, so each is read from the style once.
      const color = (/** @type {string} */ value) => {
        if (!value.startsWith("--")) return value;
        if (!colors.has(value)) colors.set(value, getComputedStyle(canvas).getPropertyValue(value).trim());
        return /** @type {string} */ (colors.get(value));
      };

      // The playhead sits at two thirds of the width, so the coming bars stay hidden.
      const start = t - (WINDOW_SECONDS * 2) / 3;
      const x = (/** @type {number} */ time) => ((time - start) / WINDOW_SECONDS) * width;
      const pitchHeight = height - DRUM_BAND - 8;
      const y = (/** @type {number} */ pitch) =>
        4 + (1 - (pitch - prepared.low) / (prepared.high - prepared.low)) * pitchHeight;

      for (const { line, path } of prepared.paths) {
        const lineColor = color(line.color);
        if (!line.monophonic) {
          // Notes of a polyphonic part are drawn as dashes; a faint part stays in the background.
          context.strokeStyle = lineColor;
          context.globalAlpha = line.faint ? 0.28 : 1;
          context.shadowColor = lineColor;
          context.shadowBlur = glow && !line.faint ? 8 : 0;
          context.lineWidth = line.width ?? 2;
          for (const note of line.notes) {
            if (note.onset > t || note.onset + note.duration < start) continue;
            context.beginPath();
            context.moveTo(x(note.onset), y(note.pitch));
            context.lineTo(x(Math.min(t, note.onset + note.duration)), y(note.pitch));
            context.stroke();
          }
          context.globalAlpha = 1;
          context.shadowBlur = 0;
          continue;
        }
        const shown = visibleUntil(path, t, start);
        context.shadowColor = lineColor;
        context.shadowBlur = glow && !line.faint ? 10 : 0;
        context.strokeStyle = lineColor;
        context.globalAlpha = line.faint ? 0.35 : 1;
        context.lineWidth = line.width ?? 2.5;
        context.lineJoin = "round";
        context.beginPath();
        let drawing = false;
        for (let index = 0; index < shown.x.length; index += 1) {
          const pitch = shown.y[index];
          if (Number.isNaN(pitch)) {
            drawing = false;
            continue;
          }
          // Steps-post: hold the pitch until the next point, then jump.
          const nextX = index + 1 < shown.x.length ? shown.x[index + 1] : shown.x[index];
          if (!drawing) context.moveTo(x(shown.x[index]), y(pitch));
          else context.lineTo(x(shown.x[index]), y(pitch));
          context.lineTo(x(nextX), y(pitch));
          drawing = true;
        }
        context.stroke();
        // A dot on every note start, so repeated notes of one pitch do not read as one long note.
        context.fillStyle = lineColor;
        for (const note of line.notes) {
          if (note.onset < start || note.onset > t) continue;
          context.beginPath();
          context.arc(x(note.onset), y(note.pitch), (line.width ?? 2.5) * 0.9, 0, Math.PI * 2);
          context.fill();
        }
        const tip = soundingPitch(path, t);
        if (tip !== null && !line.faint) {
          context.fillStyle = lineColor;
          context.beginPath();
          context.arc(x(t), y(tip), 4.5, 0, Math.PI * 2);
          context.fill();
        }
        context.shadowBlur = 0;
        context.globalAlpha = 1;
      }

      context.fillStyle = color("--no");
      for (const onset of prepared.scene.drums) {
        if (onset > t || onset < start) continue;
        const age = t - onset;
        context.globalAlpha = Math.max(0.25, 1 - age / 2);
        context.fillRect(x(onset) - 1, height - DRUM_BAND, 3, DRUM_BAND - 4);
      }
      context.globalAlpha = 1;
      context.strokeStyle = color("--line");
      context.beginPath();
      context.moveTo(x(t), 0);
      context.lineTo(x(t), height);
      context.stroke();
    },
  };
}
