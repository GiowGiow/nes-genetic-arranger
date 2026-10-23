// @ts-check
/**
 * Turntable view: the Result's record player as a page element.
 *
 * The song that was arranged sits on a turntable: the same record the shelf shows, a platter
 * under it, a tonearm over it. While the music plays the record turns at 33 and a third rpm; on
 * pause it coasts to a stop. The arm crosses the record as the song plays, so it is also the
 * progress bar: press and drag the arm (or anywhere on the record) and the song seeks there.
 *
 * This module is the page side. It owns the element, the loop, the drag and the semantics for
 * assistive technology; two renderers draw the pictures: the three.js scene
 * (`turntable-scene.js`, loaded lazily when the browser is idle, in the shelf's low-poly,
 * nearest-filtered style) and a 2D canvas (`turntable-2d.js`) that shows at once and stays when
 * WebGL is missing. The numbers (arm angle from progress, progress from a drag, the spin) are in
 * `turntable-geometry.js`.
 *
 * Cheap on a phone, by the shelf's own rules (`shelf-layout.js`): at most 30 frames a second
 * and a lower pixel ratio on a touch screen; nothing is drawn while the view is off screen or
 * the page is hidden; and the loop stops by itself when nothing moves (paused, arm settled).
 * Under reduced motion the record does not spin and the arm does not glide, but it still shows
 * where the song is.
 *
 * Keyboard: the view is a slider (`role="slider"`). The page's own keys keep working with it
 * focused (space plays, the arrows move 2 seconds); Home and End jump to the ends.
 */

import { drawRecordFace } from "./record-art.js";
import { isLowPower, pixelRatioFor, shouldRenderFrame, targetFps } from "./shelf-layout.js";
import { createTurntable2d } from "./turntable-2d.js";
import {
  REST_PROGRESS,
  approach,
  armAngleForProgress,
  armValueText,
  pickTarget,
  progressForPoint,
  stepSpin,
} from "./turntable-geometry.js";

/**
 * What a renderer draws in one frame.
 * @typedef {object} TurntableFrame
 * @property {number} spinAngle the record's turn, radians
 * @property {number} armAngle the arm's direction, radians (`turntable-geometry.js`)
 * @property {number} lift how far the needle is raised, 0 down in the groove to 1 fully up
 * @property {boolean} playing whether the motor runs (a small lamp)
 * @property {number} time seconds, for light effects
 */

/**
 * @typedef {object} TurntableRenderer
 * @property {HTMLElement | null} canvas the element it draws into
 * @property {(width: number, height: number, pixelRatio: number) => void} resize
 * @property {(face: HTMLCanvasElement | null) => void} setRecord the record's face, or none
 * @property {(frame: TurntableFrame) => void} draw
 * @property {(clientX: number, clientY: number) => {x: number, z: number} | null} planePoint
 *   where a point of the screen falls on the platter's plane, in scene units
 * @property {() => void} dispose
 */

/** How long the arm takes to settle when the song moves it, and when a drag does, in seconds. */
const ARM_TAU = 0.12;
const ARM_TAU_DRAG = 0.03;
/** How fast the needle lifts and lowers, in seconds. */
const LIFT_TAU = 0.15;
/** The lift of a paused needle: hovering a little over the groove. */
const PAUSED_LIFT = 0.55;

/**
 * Build the view inside `container` and start showing the 2D renderer.
 *
 * @param {HTMLElement} container
 * @param {object} parts
 * @param {{time: () => number, duration: () => number, playing: () => boolean}} parts.clock the
 *   player's position, the song's length, and whether it plays
 * @param {(seconds: number) => void} parts.seek called while the visitor drags, and for Home and End
 * @param {() => Promise<{createTurntableScene: (host: HTMLElement) => TurntableRenderer}>} [parts.loadScene]
 *   loads the three.js scene (default: the module `turntable-scene.js`)
 * @param {(host: HTMLElement) => TurntableRenderer} [parts.create2d]
 * @param {(canvas: HTMLCanvasElement, entry: any) => HTMLCanvasElement} [parts.drawFace] default `drawRecordFace`
 * @param {(element: HTMLElement, onSize: (size: {width: number, height: number}) => void) => () => void} [parts.observeSize]
 * @param {() => boolean} [parts.isVisible] default: on screen, page not hidden, has a size
 * @param {boolean} [parts.reducedMotion]
 * @param {boolean} [parts.coarsePointer] a touch screen
 * @param {(run: (timestamp: number) => void) => number} [parts.schedule] default `requestAnimationFrame`
 * @param {(handle: number) => void} [parts.cancel]
 * @param {(run: () => void) => void} [parts.idle] when to load the 3D scene (default `requestIdleCallback`)
 * @returns {{
 *   setRecord: (entry: any | null) => void,
 *   wake: () => void,
 *   mode: () => "2d" | "3d",
 *   dispose: () => void,
 * }} `wake` asks for a frame: call it when the player starts, pauses, seeks or changes song
 * @example
 * const turntable = createTurntable(host, {
 *   clock: { time: () => player.currentTime(), duration: () => player.duration(), playing: () => player.isPlaying() },
 *   seek: (seconds) => player.seek(seconds),
 * });
 * turntable.setRecord(catalogEntry);
 * player.onChange(() => turntable.wake());
 */
export function createTurntable(container, parts) {
  const {
    clock,
    seek,
    loadScene = () => import("./turntable-scene.js"),
    create2d = createTurntable2d,
    drawFace = drawRecordFace,
    observeSize = defaultObserveSize,
    reducedMotion = Boolean(globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches),
    coarsePointer = Boolean(globalThis.matchMedia?.("(pointer: coarse)").matches),
    schedule = (run) => requestAnimationFrame(run),
    cancel = (handle) => cancelAnimationFrame(handle),
    idle = defaultIdle,
  } = parts;
  const document = container.ownerDocument;
  const stage = document.createElement("div");
  stage.className = "turntable";
  stage.setAttribute("role", "slider");
  stage.setAttribute("tabindex", "0");
  stage.setAttribute("aria-label", "Position in the song: the tonearm on the record");
  stage.setAttribute("aria-valuemin", "0");
  stage.setAttribute("aria-valuemax", "0");
  stage.setAttribute("aria-valuenow", "0");
  stage.setAttribute("aria-valuetext", "No song loaded");
  container.append(stage);

  /** @type {TurntableRenderer} */
  let renderer = create2d(stage);
  let mode = /** @type {"2d" | "3d"} */ ("2d");
  /** @type {HTMLCanvasElement | null} the record's face, kept to hand to a renderer that arrives later */
  let face = null;
  let size = { width: 0, height: 0 };
  let lowPower = isLowPower({ coarsePointer, width: 0 });
  let ratio = 1;

  let spin = { angle: 0, speed: 0 };
  let armAngle = armAngleForProgress(REST_PROGRESS);
  let lift = 1;
  let dragging = false;

  let dirty = true;
  let lastDrawn = Number.NEGATIVE_INFINITY;
  let handle = 0;
  let disposed = false;
  let onScreen = true;
  let shownSecond = -1;
  let shownDuration = -1;

  const isVisible =
    parts.isVisible ?? (() => document.visibilityState !== "hidden" && onScreen && size.width > 0);

  /** Put the renderer at the stage's size and the right pixel ratio. */
  function fit() {
    if (!size.width || !size.height) return;
    lowPower = isLowPower({ coarsePointer, width: size.width });
    ratio = pixelRatioFor(globalThis.devicePixelRatio, lowPower);
    renderer.resize(size.width, size.height, ratio);
    dirty = true;
  }

  let sceneRequested = false;
  const stopObserving = observeSize(stage, (next) => {
    size = next;
    fit();
    wake();
    // The 3D scene is about 800 KB and a second WebGL context: fetched when the turntable is first
    // on screen and the browser is idle, not at page load (the shelf has its own).
    if (next.width > 0 && !sceneRequested) {
      sceneRequested = true;
      idle(loadSceneWhenIdle);
    }
  });

  /** @type {IntersectionObserver | null} */
  const intersection =
    !parts.isVisible && typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
          onScreen = entries[entries.length - 1].isIntersecting;
          if (onScreen) wake();
        })
      : null;
  intersection?.observe(stage);
  const onVisibility = () => {
    if (document.visibilityState !== "hidden") wake();
  };
  document.addEventListener?.("visibilitychange", onVisibility);

  function wake() {
    dirty = true;
    if (!handle && !disposed) handle = schedule(tick);
  }

  /** @param {number} timestamp milliseconds */
  function tick(timestamp) {
    handle = 0;
    if (disposed) return;
    const visible = isVisible();
    const playing = clock.playing();
    const duration = clock.duration();
    const time = clock.time();
    // Under reduced motion nothing animates, so a moved position is the only reason to draw.
    if (reducedMotion && playing && Math.abs(time - shownTime) > 0.25) dirty = true;
    const moving = !reducedMotion && (playing || spin.speed > 0.02);
    const target = targets(playing, duration, time);
    const settling = Math.abs(armAngle - target.arm) > 5e-4 || Math.abs(lift - target.lift) > 0.01;
    if (shouldRenderFrame({ visible, animated: moving || settling, dirty, now: timestamp, last: lastDrawn, fps: targetFps(lowPower) })) {
      const seconds = Number.isFinite(lastDrawn) ? (timestamp - lastDrawn) / 1000 : 1 / 30;
      lastDrawn = timestamp;
      advance(seconds, playing, target);
      shownTime = time;
      showSlider(time, duration);
      renderer.draw({ spinAngle: spin.angle, armAngle, lift, playing, time: timestamp / 1000 });
      dirty = Math.abs(armAngle - target.arm) > 5e-4 || Math.abs(lift - target.lift) > 0.01 || (!reducedMotion && spin.speed > 0.02);
    }
    if (visible && (dirty || playing || spin.speed > 0.02)) handle = schedule(tick);
  }
  let shownTime = -1;

  /**
   * Where the arm and its lift are heading.
   * @param {boolean} playing @param {number} duration @param {number} time
   */
  function targets(playing, duration, time) {
    const progress = duration > 0 ? Math.min(1, Math.max(0, time / duration)) : REST_PROGRESS;
    return {
      arm: armAngleForProgress(progress),
      lift: duration <= 0 ? 1 : playing ? 0 : PAUSED_LIFT,
    };
  }

  /**
   * @param {number} seconds @param {boolean} playing
   * @param {{arm: number, lift: number}} target
   */
  function advance(seconds, playing, target) {
    if (reducedMotion) {
      armAngle = target.arm;
      lift = target.lift;
      return;
    }
    spin = stepSpin(spin, seconds, playing);
    armAngle = approach(armAngle, target.arm, seconds, dragging ? ARM_TAU_DRAG : ARM_TAU);
    lift = approach(lift, target.lift, seconds, LIFT_TAU);
  }

  /** The slider's attributes change at most once a second: a screen reader should not chatter. */
  function showSlider(/** @type {number} */ time, /** @type {number} */ duration) {
    const second = Math.floor(time);
    if (second === shownSecond && duration === shownDuration) return;
    shownSecond = second;
    shownDuration = duration;
    stage.setAttribute("aria-valuemax", String(Math.round(duration)));
    stage.setAttribute("aria-valuenow", String(second));
    stage.setAttribute("aria-valuetext", armValueText(time, duration));
  }

  // ---- The drag: the arm (or the record) follows the pointer, and the song seeks there ----

  /** @param {{clientX: number, clientY: number}} event @returns {number | null} progress, or null off the plane */
  function progressAt(event) {
    const point = renderer.planePoint(event.clientX, event.clientY);
    return point ? progressForPoint(point) : null;
  }

  stage.addEventListener("pointerdown", (/** @type {any} */ event) => {
    const duration = clock.duration();
    if (!(duration > 0)) return;
    const point = renderer.planePoint(event.clientX, event.clientY);
    if (!point || !pickTarget(point, armAngle)) return;
    dragging = true;
    event.preventDefault?.();
    stage.setPointerCapture?.(event.pointerId);
    seek(progressForPoint(point) * duration);
    wake();
  });
  stage.addEventListener("pointermove", (/** @type {any} */ event) => {
    const duration = clock.duration();
    if (!dragging) {
      const point = duration > 0 ? renderer.planePoint(event.clientX, event.clientY) : null;
      stage.style.cursor = point && pickTarget(point, armAngle) ? "grab" : "";
      return;
    }
    const progress = progressAt(event);
    if (progress !== null) seek(progress * duration);
    wake();
  });
  const release = () => {
    dragging = false;
    wake();
  };
  stage.addEventListener("pointerup", release);
  stage.addEventListener("pointercancel", release);
  stage.addEventListener("keydown", (/** @type {any} */ event) => {
    const duration = clock.duration();
    if (!(duration > 0)) return;
    if (event.key === "Home") seek(0);
    else if (event.key === "End") seek(duration);
    else if (event.key === "PageUp") seek(clock.time() + 10);
    else if (event.key === "PageDown") seek(clock.time() - 10);
    else return;
    event.preventDefault?.();
    wake();
  });

  // ---- The 3D scene arrives when the browser has nothing better to do ----

  async function loadSceneWhenIdle() {
    if (disposed) return;
    try {
      const { createTurntableScene } = await loadScene();
      if (disposed) return;
      const next = createTurntableScene(stage);
      // The 2D picture stays until the scene has been sized and has the record: no blank frame.
      next.resize(size.width, size.height, ratio);
      next.setRecord(face);
      const old = renderer;
      renderer = next;
      mode = "3d";
      stage.classList.add("is-3d");
      old.dispose();
      fit();
      wake();
    } catch {
      // No WebGL, or the module could not load: the 2D renderer stays.
    }
  }

  return {
    setRecord(entry) {
      face = entry ? drawFace(document.createElement("canvas"), entry) : null;
      renderer.setRecord(face);
      wake();
    },
    wake,
    mode: () => mode,
    dispose() {
      disposed = true;
      if (handle) cancel(handle);
      handle = 0;
      stopObserving();
      intersection?.disconnect();
      document.removeEventListener?.("visibilitychange", onVisibility);
      renderer.dispose();
      stage.remove();
    },
  };
}

/**
 * @param {HTMLElement} element
 * @param {(size: {width: number, height: number}) => void} onSize
 * @returns {() => void}
 */
function defaultObserveSize(element, onSize) {
  const observer = new ResizeObserver(([entry]) => onSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
  observer.observe(element);
  return () => observer.disconnect();
}

/** @param {() => void} run */
function defaultIdle(run) {
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 2000 });
  else setTimeout(run, 300);
}
