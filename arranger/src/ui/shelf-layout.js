// @ts-check
/**
 * Shelf layout: where each vinyl record of a catalog page sits and how it moves (spec 005,
 * story 3, research R6).
 *
 * A page is a grid of records: 5 columns by 3 rows on a wide screen, 3 by 3 on a phone. The
 * look takes after the PS2 memory card screen: the records float and bob gently; the selected
 * one comes forward, rises, grows, and spins like a record on a turntable while it sways from
 * side to side. Under reduced motion every record holds still.
 *
 * Under each record hangs a small strip with the song's title. A title that does not fit scrolls
 * slowly like a marquee (after a short wait, so it can be read from its start); under reduced
 * motion it is cut with an ellipsis instead. The same module holds the numbers that keep the
 * scene cheap on a phone: a frame-rate cap, a lower pixel ratio, and the rule for when a frame
 * is worth drawing at all.
 *
 * These are pure numbers in scene units (a record has radius 1 before scaling), so they are
 * tested without WebGL; `shelf-scene.js` applies them to three.js objects every frame, and
 * `song-shelf.js` uses the same column count for its keyboard moves and its 2D grid.
 */

/** Below this stage width, in CSS pixels, the shelf shows 3 columns instead of 5. */
export const NARROW_WIDTH = 560;

/** Rows of records on every page. */
export const SHELF_ROWS = 3;

/** Distance between the centres of two neighbouring records. */
export const RECORD_SPACING = 1.7;

/** Vertical field of view of the camera, in degrees. */
export const CAMERA_FOV = 42;

/** Width of the glow behind the selected record, in scene units (the camera leaves room for it). */
export const HALO_SCALE = 2.6;

/** How fast a record's size follows its target, as a share of the distance per 60 fps frame. */
export const SCALE_EASING = 0.15;

/** The selected record's most extreme sway, in radians: little enough to stay in front of the glow. */
const SWAY = 0.32;

/** Scale of a resting record and of the selected one (a record has radius 1 at scale 1). */
const RESTING_SCALE = 0.58;
const SELECTED_SCALE = 0.92;

/** How far the selected record comes toward the camera and rises. */
const SELECTED_FORWARD = 1.1;
const SELECTED_RISE = 0.12;

/** Height of the bob, and the resting records' slight turn toward the light. */
const BOB_HEIGHT = 0.05;
const RESTING_TILT = 0.2;

/** Width of a title strip in scene units: narrower than the spacing, so neighbours never touch. */
export const STRIP_WIDTH = 1.5;

/**
 * Size of a title strip's texture in pixels. Its proportions are the strip's, so one texel is
 * square on screen.
 */
export const STRIP_PIXELS = { width: 128, height: 18 };

/** Height of a title strip in scene units. */
export const STRIP_HEIGHT = (STRIP_WIDTH * STRIP_PIXELS.height) / STRIP_PIXELS.width;

/** Empty pixels at each end of a title that fits the strip, and where a scrolling title starts. */
export const STRIP_PADDING = 6;

/** Space between a record's rim and its strip, in scene units. */
const STRIP_GAP = 0.04;

/** How far a strip's lower edge hangs below the row's centre, in the worst case (the selected record). */
const STRIP_REACH = SELECTED_SCALE - SELECTED_RISE + BOB_HEIGHT + STRIP_GAP + STRIP_HEIGHT;

/** Marquee speed in texture pixels per second: slow enough to read. */
export const MARQUEE_SPEED = 24;

/** Seconds a scrolling title waits at its start before each pass. */
export const MARQUEE_PAUSE = 1.6;

/** Empty pixels between the end of a scrolling title and its next copy. */
export const MARQUEE_GAP = 32;

/** Seconds between one record's marquee and the next one's, so the titles do not move in step. */
export const MARQUEE_STAGGER = 0.45;

/** The longest wait between frames a record's growth counts, in milliseconds (a tab coming back). */
const LONGEST_STEP = 100;

/** Frame-rate caps: a phone's GPU and battery are spared, a desktop gets the full 60. */
const FPS_DESKTOP = 60;
const FPS_PHONE = 30;

/** The canvas draws this share of the device's pixels, 0.6 on a desktop and less on a phone. */
const PIXEL_SCALE_DESKTOP = 0.6;
const PIXEL_SCALE_PHONE = 0.5;

/**
 * @typedef {object} RecordPose a record's place and turn at one moment
 * @property {number} x
 * @property {number} y
 * @property {number} z toward the camera
 * @property {number} tilt turn about the vertical axis, in radians (the sway)
 * @property {number | null} spin turn of the disc about its own axis, in radians; null keeps
 *   the disc where it stopped
 * @property {number} scale
 */

/**
 * Columns of a page for a stage of this width.
 *
 * @param {number} width the stage's width in CSS pixels; 0 when it is hidden
 * @returns {number} 5, or 3 on a narrow stage
 * @example
 * shelfColumns(375); // 3
 * shelfColumns(1200); // 5
 */
export function shelfColumns(width) {
  return width > 0 && width < NARROW_WIDTH ? 3 : 5;
}

/**
 * Records per page for a stage of this width.
 *
 * @param {number} width
 * @returns {number} 15, or 9 on a narrow stage
 * @example
 * perPageFor(375); // 9
 */
export function perPageFor(width) {
  return shelfColumns(width) * SHELF_ROWS;
}

/**
 * The resting centre of a page's record, row by row from the top left.
 *
 * @param {number} index place on the page, 0 for the first record
 * @param {number} columns
 * @returns {{x: number, y: number}}
 * @example
 * recordPosition(7, 5); // { x: 0, y: 0 }: the middle of a 5×3 page
 * recordPosition(0, 5); // { x: -3.4, y: 1.7 }
 */
export function recordPosition(index, columns) {
  const row = Math.floor(index / columns);
  const column = index % columns;
  return {
    x: (column - (columns - 1) / 2) * RECORD_SPACING,
    y: ((SHELF_ROWS - 1) / 2 - row) * RECORD_SPACING,
  };
}

/**
 * How far the camera stands from the records' plane so the whole page fits the stage, with room
 * for the selected record, which comes forward and grows, and for the glow around it.
 *
 * @param {number} columns
 * @param {number} aspect the stage's width divided by its height
 * @returns {number} in scene units
 * @example
 * cameraDistance(5, 2); // about 9.5: the height decides on a wide stage
 */
export function cameraDistance(columns, aspect) {
  const halfTan = Math.tan(((CAMERA_FOV / 2) * Math.PI) / 180);
  // The edge records' centres, plus the glow around the selected one, which must not be cut off
  const neededWidth = (columns - 1) * RECORD_SPACING + HALO_SCALE + 0.4;
  // Below and above a row, the glow reaches farther than the title strip does, but the strip
  // sets the limit if it ever grows, so both count
  const reach = Math.max(HALO_SCALE / 2, STRIP_REACH) + 0.25;
  const neededHeight = (SHELF_ROWS - 1) * RECORD_SPACING + 2 * reach;
  return Math.max(neededWidth / 2 / (halfTan * aspect), neededHeight / 2 / halfTan) + 1;
}

/**
 * Where a record is and how it is turned at a moment.
 *
 * Each record bobs on its own phase (from its index), so the page ripples instead of moving as
 * one block.
 *
 * @param {number} index place on the page
 * @param {{selected: boolean, columns: number, time: number, reducedMotion: boolean}} state
 *   `time` in seconds since the scene started
 * @returns {RecordPose}
 * @example
 * recordPose(7, { selected: true, columns: 5, time: 0, reducedMotion: true });
 * // { x: 0, y: 0.12, z: 1.1, tilt: 0, spin: 0, scale: 0.92 }
 */
export function recordPose(index, { selected, columns, time, reducedMotion }) {
  const { x, y } = recordPosition(index, columns);
  const bob = reducedMotion ? 0 : Math.sin(time * 1.4 + index * 0.7) * BOB_HEIGHT;
  if (selected) {
    return {
      x,
      y: y + bob + SELECTED_RISE,
      z: SELECTED_FORWARD,
      tilt: reducedMotion ? 0 : Math.sin(time * 1.2) * SWAY,
      spin: reducedMotion ? 0 : -time * 2.2,
      scale: SELECTED_SCALE,
    };
  }
  return {
    x,
    y: y + bob,
    z: 0,
    tilt: RESTING_TILT + (reducedMotion ? 0 : Math.sin(time * 0.6 + index) * 0.1),
    spin: null,
    scale: RESTING_SCALE,
  };
}

/**
 * Opacity of the glow behind the selected record: a slow pulse, steady under reduced motion.
 *
 * @param {number} time seconds
 * @param {boolean} reducedMotion
 * @returns {number} from 0.48 to 0.72
 * @example
 * haloOpacity(0, true); // 0.6
 */
export function haloOpacity(time, reducedMotion) {
  return 0.6 + (reducedMotion ? 0 : 0.12 * Math.sin(time * 3));
}

/**
 * Height of a title strip's centre, hanging just below its record's rim.
 *
 * @param {number} recordY the record's centre height
 * @param {number} recordScale the record's size (radius), as it is now while it grows
 * @returns {number}
 * @example
 * stripY(0, 0.58); // about -0.73
 */
export function stripY(recordY, recordScale) {
  return recordY - recordScale - STRIP_GAP - STRIP_HEIGHT / 2;
}

/**
 * Whether a title is wider than the strip's room for it, so it must scroll (or be cut).
 *
 * @param {number} textWidth the title's measured width in texture pixels
 * @returns {boolean}
 * @example
 * titleNeedsScroll(90); // false
 * titleNeedsScroll(300); // true
 */
export function titleNeedsScroll(textWidth) {
  return textWidth > STRIP_PIXELS.width - 2 * STRIP_PADDING;
}

/**
 * Pixels the marquee travels before it looks the way it started: the text and the gap after it.
 *
 * @param {number} textWidth
 * @returns {number}
 */
export function marqueeCycle(textWidth) {
  return textWidth + MARQUEE_GAP;
}

/**
 * How far a scrolling title has moved at a moment: it waits, moves at a steady speed for one
 * cycle, and starts over.
 *
 * @param {number} time seconds
 * @param {number} cycle pixels in one pass (`marqueeCycle`)
 * @returns {number} texture pixels from 0 up to, but not including, `cycle`
 * @example
 * marqueeOffset(0, 332); // 0: still waiting
 * marqueeOffset(2.6, 332); // 24: one second after the wait
 */
export function marqueeOffset(time, cycle) {
  const period = MARQUEE_PAUSE + cycle / MARQUEE_SPEED;
  const phase = ((time % period) + period) % period;
  return phase < MARQUEE_PAUSE ? 0 : (phase - MARQUEE_PAUSE) * MARQUEE_SPEED;
}

/**
 * A title cut to fit a width, ending with an ellipsis; a title that fits is returned whole.
 * Used when nothing scrolls (reduced motion).
 *
 * @param {string} text
 * @param {number} maxWidth in the unit `measure` returns
 * @param {(text: string) => number} measure the width of a text in the font that will draw it
 * @returns {string}
 * @example
 * ellipsize("Korobeiniki (Tetris Theme A)", 60, (t) => t.length * 5); // "Korobeiniki…"
 */
export function ellipsize(text, maxWidth, measure) {
  if (measure(text) <= maxWidth) return text;
  let length = text.length - 1;
  while (length > 0 && measure(`${text.slice(0, length).trimEnd()}…`) > maxWidth) length--;
  return length > 0 ? `${text.slice(0, length).trimEnd()}…` : "…";
}

/**
 * How bright a title strip is: full for the selected record, dimmer for the rest.
 *
 * @param {boolean} selected
 * @returns {number} an opacity from 0 to 1
 */
export function stripOpacity(selected) {
  return selected ? 1 : 0.6;
}

/**
 * Whether the device is one to spare: a touch screen, or a narrow stage (a phone held upright).
 *
 * @param {{coarsePointer: boolean, width: number}} device `coarsePointer` from the media query
 *   `(pointer: coarse)`; `width` the stage's CSS width, 0 when it is hidden
 * @returns {boolean}
 * @example
 * isLowPower({ coarsePointer: false, width: 375 }); // true
 */
export function isLowPower({ coarsePointer, width }) {
  return coarsePointer || (width > 0 && width < NARROW_WIDTH);
}

/**
 * The most frames a second the animation draws.
 *
 * @param {boolean} lowPower
 * @returns {number} 30 on a phone, 60 otherwise
 */
export function targetFps(lowPower) {
  return lowPower ? FPS_PHONE : FPS_DESKTOP;
}

/**
 * The renderer's pixel ratio: the device's, capped at 2 (more is invisible and costly), scaled
 * down for the chunky pixel look, and a little lower still on a phone.
 *
 * @param {number} deviceRatio `devicePixelRatio`; 0 or missing counts as 1
 * @param {boolean} lowPower
 * @returns {number}
 * @example
 * pixelRatioFor(3, false); // 1.2
 * pixelRatioFor(3, true); // 1
 */
export function pixelRatioFor(deviceRatio, lowPower) {
  return Math.min(deviceRatio || 1, 2) * (lowPower ? PIXEL_SCALE_PHONE : PIXEL_SCALE_DESKTOP);
}

/**
 * Whether the loop should draw a frame now. A hidden stage never draws. With motion, a frame is
 * drawn when the frame cap allows it; under reduced motion only after a change (a new page, a
 * selection, a resize), which ignores the cap.
 *
 * A frame that arrives up to a quarter of the interval early still counts: a 60 Hz display
 * delivers 33.3 ms frames as 33.2 or 33.4, and refusing the early ones would halve the rate.
 *
 * @param {{visible: boolean, animated: boolean, dirty: boolean, now: number, last: number, fps: number}} state
 *   `now` and `last` in milliseconds (the time of the last drawn frame); `visible` is false when
 *   the page is hidden, the stage is off screen or has no size
 * @returns {boolean}
 * @example
 * shouldRenderFrame({ visible: true, animated: true, dirty: false, now: 1017, last: 1000, fps: 30 }); // false
 */
export function shouldRenderFrame({ visible, animated, dirty, now, last, fps }) {
  if (!visible) return false;
  if (dirty) return true;
  if (!animated) return false;
  const interval = 1000 / fps;
  return now - last >= interval * 0.75;
}

/**
 * The share of the way to its target size that a record covers in one step, so the growth lasts
 * as long in seconds at 30 fps as at 60.
 *
 * @param {number} elapsed milliseconds since the last drawn frame; a long pause counts as 100
 * @returns {number} from 0 to 1
 * @example
 * scaleEasing(1000 / 60); // 0.15
 */
export function scaleEasing(elapsed) {
  const frames = Math.min(Math.max(elapsed, 0), LONGEST_STEP) / (1000 / 60);
  return 1 - (1 - SCALE_EASING) ** frames;
}
