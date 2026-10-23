// @ts-check
/**
 * Turntable geometry: the numbers behind the Result's record player.
 *
 * The Result shows the song as a record on a turntable. While it plays, the record turns at the
 * speed of a 33 and a third rpm LP and the tonearm crosses it from the outer groove to the inner
 * one, so the arm is also the progress bar: its angle says how far the song has played, and
 * dragging it seeks. This module holds the pure numbers; `turntable-scene.js` (three.js) and
 * `turntable-2d.js` (the canvas fallback) only draw them.
 *
 * The arm is a real pivoting arm, so its angle is not a straight line of progress. Seen from
 * above (x to the right, z toward the viewer), the platter's spindle is at the origin and the
 * record has radius 1. The arm turns about a pivot beside the platter; its needle is at distance
 * `ARM_LENGTH` from the pivot, on an arc. A groove is a circle around the spindle, so the angle
 * that puts the needle in the groove of radius r comes from the law of cosines in the triangle
 * spindle - pivot - needle. Time maps to groove radius in a straight line (the grooves of a
 * record are laid down at a steady pitch), and the radius maps to the arm angle by that triangle.
 *
 * Playing a record is also a speed: a platter does not jump to 33 rpm, it takes a third of a
 * second to get there, and coasts for about a second when the motor stops. `stepSpin` models
 * both with the same exponential approach.
 */

/** The platter's speed at 33 and a third revolutions a minute, in radians per second. */
export const PLATTER_SPEED = ((100 / 3) * 2 * Math.PI) / 60;

/** Radius of the record, the unit of the scene. */
export const RECORD_RADIUS = 1;

/** Where the music starts and ends on the record, as groove radii (the label covers the middle). */
export const GROOVE_OUTER = 0.93;
export const GROOVE_INNER = 0.5;

/** Where the arm's pivot stands, beside the platter at the back right (x right, z toward the viewer). */
export const ARM_PIVOT = Object.freeze({ x: 1.3, z: -0.95 });

/** The distance from the pivot to the needle. */
export const ARM_LENGTH = 1.45;

/** The progress where the arm rests off the record: before the song, with the needle past the edge. */
export const REST_PROGRESS = -0.45;

/** Time constants of the platter, in seconds: up to speed quickly, and a slower coast to a stop. */
const SPIN_UP_SECONDS = 0.3;
const SPIN_DOWN_SECONDS = 0.8;

/** A pause between frames longer than this counts as this long (a hidden tab coming back). */
const LONGEST_STEP_SECONDS = 0.25;

const PIVOT_DISTANCE = Math.hypot(ARM_PIVOT.x, ARM_PIVOT.z);
/** The direction from the pivot toward the spindle. */
const TOWARD_SPINDLE = Math.atan2(-ARM_PIVOT.z, -ARM_PIVOT.x);

/** The nearest and farthest the needle can be from the spindle. */
const REACH_MIN = Math.abs(PIVOT_DISTANCE - ARM_LENGTH) + 1e-6;
const REACH_MAX = PIVOT_DISTANCE + ARM_LENGTH - 1e-6;

/**
 * The groove radius under the needle at a point of the song.
 *
 * @param {number} progress 0 at the start of the song, 1 at the end; below 0 is off the record
 * @returns {number} distance from the spindle
 * @example
 * needleRadius(0); // 0.93, the outer groove
 * needleRadius(1); // 0.5, the inner groove
 */
export function needleRadius(progress) {
  return GROOVE_OUTER - (GROOVE_OUTER - GROOVE_INNER) * progress;
}

/**
 * The angle of the arm, from the pivot to the needle, when the needle is in the groove of a
 * point of the song. Triangle spindle - pivot - needle: the arm's angle is the direction to the
 * spindle turned away by the angle at the pivot, which the law of cosines gives.
 *
 * @param {number} progress 0 to 1 over the song; `REST_PROGRESS` is the parked arm
 * @returns {number} radians, as `Math.atan2(z, x)` of the arm's direction
 * @example
 * armAngleForProgress(0) < armAngleForProgress(1); // true: the arm swings inward as the song plays
 */
export function armAngleForProgress(progress) {
  const radius = Math.min(REACH_MAX, Math.max(REACH_MIN, needleRadius(progress)));
  const cosine = (PIVOT_DISTANCE ** 2 + ARM_LENGTH ** 2 - radius ** 2) / (2 * PIVOT_DISTANCE * ARM_LENGTH);
  return TOWARD_SPINDLE - Math.acos(Math.min(1, Math.max(-1, cosine)));
}

/**
 * Where the needle is for an arm angle.
 *
 * @param {number} angle the arm's direction in radians
 * @returns {{x: number, z: number}}
 * @example
 * armTip(armAngleForProgress(0)); // a point 0.93 from the spindle
 */
export function armTip(angle) {
  return { x: ARM_PIVOT.x + ARM_LENGTH * Math.cos(angle), z: ARM_PIVOT.z + ARM_LENGTH * Math.sin(angle) };
}

/**
 * The progress of the song at which the needle sits for an arm angle; the inverse of
 * `armAngleForProgress`. An angle before the start of the song gives 0, one past its end gives 1.
 *
 * @param {number} angle the arm's direction in radians, any turn
 * @returns {number} from 0 to 1
 * @example
 * progressForArmAngle(armAngleForProgress(0.25)); // 0.25
 */
export function progressForArmAngle(angle) {
  const start = armAngleForProgress(0);
  const end = armAngleForProgress(1);
  // Bring the angle to the turn that is nearest the middle of the sweep, so atan2's wrap at 180
  // degrees cannot send a drag to the wrong end.
  const middle = (start + end) / 2;
  let turned = angle - middle;
  turned -= Math.round(turned / (2 * Math.PI)) * 2 * Math.PI;
  const wrapped = middle + turned;
  if (wrapped <= start) return 0;
  if (wrapped >= end) return 1;
  const tip = armTip(wrapped);
  return (GROOVE_OUTER - Math.hypot(tip.x, tip.z)) / (GROOVE_OUTER - GROOVE_INNER);
}

/**
 * The progress a drag asks for when the pointer is at a point of the platter's plane: the arm
 * aims at the point, and the needle drops where the aimed arm meets its groove.
 *
 * @param {{x: number, z: number}} point in the scene's units, spindle at the origin
 * @returns {number} from 0 to 1
 * @example
 * progressForPoint(armTip(armAngleForProgress(0.3))); // 0.3
 */
export function progressForPoint(point) {
  return progressForArmAngle(Math.atan2(point.z - ARM_PIVOT.z, point.x - ARM_PIVOT.x));
}

/** How near a press must be to the arm to grab it, in scene units (a thumb is wider than a tube). */
const ARM_GRAB = 0.16;

/**
 * What a press at a point of the platter's plane grabs: the arm (its tube or its needle), the
 * record, or nothing. The arm is checked first, because it lies over the record.
 *
 * @param {{x: number, z: number}} point in scene units
 * @param {number} angle the arm's current direction
 * @returns {"arm" | "record" | null}
 * @example
 * pickTarget({ x: 0, z: 0 }, armAngleForProgress(0.5)); // "record"
 */
export function pickTarget(point, angle) {
  const tip = armTip(angle);
  const dx = tip.x - ARM_PIVOT.x;
  const dz = tip.z - ARM_PIVOT.z;
  const along = Math.max(0, Math.min(1, ((point.x - ARM_PIVOT.x) * dx + (point.z - ARM_PIVOT.z) * dz) / (dx * dx + dz * dz)));
  const nearest = { x: ARM_PIVOT.x + dx * along, z: ARM_PIVOT.z + dz * along };
  if (Math.hypot(point.x - nearest.x, point.z - nearest.z) <= ARM_GRAB) return "arm";
  if (Math.hypot(point.x, point.z) <= RECORD_RADIUS) return "record";
  return null;
}

/**
 * The turn of the platter after a step, easing toward its speed.
 *
 * Playing aims at `PLATTER_SPEED`, paused at 0, and the speed closes the gap exponentially. The
 * angle gained in the step is the integral of that speed, not speed times step, so a long frame
 * and two short ones turn the record the same.
 *
 * @param {{angle: number, speed: number}} spin angle in radians (kept within one turn) and speed
 *   in radians per second
 * @param {number} seconds time since the last step
 * @param {boolean} playing whether the motor runs
 * @returns {{angle: number, speed: number}} a new state
 * @example
 * stepSpin({ angle: 0, speed: 0 }, 1, true).speed; // close to PLATTER_SPEED
 */
export function stepSpin({ angle, speed }, seconds, playing) {
  const dt = Math.min(Math.max(seconds, 0), LONGEST_STEP_SECONDS);
  const target = playing ? PLATTER_SPEED : 0;
  const tau = playing ? SPIN_UP_SECONDS : SPIN_DOWN_SECONDS;
  const decay = Math.exp(-dt / tau);
  const gained = target * dt + (speed - target) * tau * (1 - decay);
  const turn = Math.PI * 2;
  return { angle: (((angle + gained) % turn) + turn) % turn, speed: target + (speed - target) * decay };
}

/** The camera's vertical field of view, in degrees, and how much of the scene must fit it. */
export const CAMERA_FOV = 34;
const FIT_WIDTH = 4.1;
const FIT_DEPTH_DISTANCE = 5.0;

/**
 * How far the camera stands from the middle of the turntable, in scene units, so that the whole
 * plinth fits the stage: the width of the plinth decides on a narrow stage, its depth on a wide one.
 *
 * @param {number} aspect the stage's width over its height
 * @returns {number}
 * @example
 * cameraDistance(1.16); // about 4.9
 */
export function cameraDistance(aspect) {
  const halfHeight = Math.tan((CAMERA_FOV / 2) * (Math.PI / 180));
  return Math.max(FIT_DEPTH_DISTANCE, FIT_WIDTH / (2 * halfHeight * Math.max(aspect, 0.2)));
}

/**
 * A value moving toward a target the way a physical thing does: fast at first, then settling.
 * Used for the arm's lift and its swing, so a seek does not snap the arm.
 *
 * @param {number} value where it is
 * @param {number} target where it is going
 * @param {number} seconds time since the last step
 * @param {number} tau the time constant, in seconds: about two thirds of the way in one tau
 * @returns {number}
 * @example
 * approach(0, 1, 0.1, 0.1); // 0.632…
 */
export function approach(value, target, seconds, tau) {
  return target + (value - target) * Math.exp(-Math.max(0, seconds) / tau);
}

/**
 * What a screen reader hears for the arm: the time and the length of the song.
 *
 * @param {number} seconds the position
 * @param {number} duration the length; 0 when nothing is loaded
 * @returns {string}
 * @example
 * armValueText(12.4, 51); // "0:12 of 0:51"
 */
export function armValueText(seconds, duration) {
  if (!(duration > 0)) return "No song loaded";
  return `${clock(seconds)} of ${clock(duration)}`;
}

/** @param {number} seconds */
function clock(seconds) {
  const whole = Math.floor(Math.max(0, seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
