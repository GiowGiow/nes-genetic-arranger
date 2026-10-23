/**
 * Shelf layout: where each vinyl record of a catalog page sits and how it moves (spec 005,
 * story 3, research R6).
 *
 * A page is a grid of records, always 3 rows, with as many columns as the stage's width allows:
 * 3 on a phone, 5 at medium widths, 7 on a wide stage and 9 on a very wide one, so a record keeps
 * about the same size and a wider shelf simply shows more of them. The look takes after the PS2
 * memory card screen: the records float and bob gently; the selected one comes forward, rises,
 * grows, and spins like a record on a turntable while it sways from side to side. Under reduced
 * motion every record holds still.
 *
 * Under each record hangs its title, as a DOM label rather than a texture: the 3D canvas draws
 * at about half the device's pixels (the chunky look, and a light load on a phone), which made
 * painted letters blurry. This module holds the numbers that place such a label (the record's
 * rim projected to the stage's pixels, the label's width) and the timing of the marquee that
 * slides a title too long for it. The same module holds the numbers that keep the scene cheap on
 * a phone: a frame-rate cap, a lower pixel ratio, and the rule for when a frame is worth drawing.
 *
 * These are pure numbers in scene units (a record has radius 1 before scaling), so they are
 * tested without WebGL; `shelf-scene.js` applies them to three.js objects every frame, and
 * `song-shelf.js` uses the same column count for its keyboard moves and its 2D grid.
 */

/** Below this stage width, in CSS pixels, the shelf is a phone's: 3 columns, and a lighter scene. */
export const NARROW_WIDTH = 560;

/**
 * The narrowest stage width, in CSS pixels, that shows each column count, widest first. Each
 * step gives a record about the same room (a scene unit stays near 57 px wide): the stage's
 * height is fixed by the page, so a wider stage can only show more records, not bigger ones.
 */
const COLUMN_STEPS = [
  [960, 9],
  [760, 7],
  [NARROW_WIDTH, 5],
];

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

/** The tallest a label can be in CSS pixels (one line of 13 to 14 px text with its padding). */
export const LABEL_HEIGHT_PX = 22;

/** The label is this many CSS pixels narrower than the pitch of the records, so neighbours never touch. */
const LABEL_GUTTER_PX = 8;

/** No label is narrower than this, in CSS pixels: a few letters must always fit. */
const LABEL_MIN_WIDTH_PX = 40;

/** Room the camera keeps below the bottom row for a label, in scene units. */
const LABEL_REACH = SELECTED_SCALE - SELECTED_RISE + BOB_HEIGHT + 0.4;

/** Marquee speed in CSS pixels per second: slow enough to read. */
export const MARQUEE_SPEED = 28;

/** Share of one loop of the marquee that is movement; the rest is a rest on the first letters. */
const MARQUEE_MOVING_SHARE = 0.85;

/** Space between the end of a scrolling title and its next copy, in CSS pixels. */
export const MARQUEE_GAP = 32;

/** An overflow smaller than this many pixels is not worth moving for. */
const MARQUEE_MIN_OVERFLOW = 1;

/** Labels start their slide this many seconds apart, repeating after 6 of them. */
const MARQUEE_STAGGER = 0.5;
const MARQUEE_STAGGER_PERIOD = 6;

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
 * @returns {number} 3 on a phone, then 5, 7 and 9 as the stage widens
 * @example
 * shelfColumns(375); // 3
 * shelfColumns(700); // 5
 * shelfColumns(824); // 7
 * shelfColumns(1000); // 9
 */
export function shelfColumns(width) {
  if (width <= 0) return 5; // hidden: nothing to measure yet, so a medium layout
  for (const [narrowest, columns] of COLUMN_STEPS) if (width >= narrowest) return columns;
  return 3;
}

/**
 * Records per page for a stage of this width.
 *
 * @param {number} width
 * @returns {number} 9, 15, 21 or 27
 * @example
 * perPageFor(375); // 9
 * perPageFor(824); // 21
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
  // Below and above a row, the glow reaches farther than the title label does, but the label
  // sets the limit if it ever grows, so both count
  const reach = Math.max(HALO_SCALE / 2, LABEL_REACH) + 0.25;
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
 * Where a point of the scene lands on the stage, once the camera has projected it.
 *
 * `vector.project(camera)` gives normalized device coordinates: x and y from -1 to 1, y up.
 * Page elements are placed in CSS pixels from the top left, y down.
 *
 * @param {{x: number, y: number}} ndc
 * @param {number} width the stage's width in CSS pixels
 * @param {number} height the stage's height in CSS pixels
 * @returns {{x: number, y: number}}
 * @example
 * ndcToPixels({ x: 0, y: 0 }, 400, 300); // { x: 200, y: 150 }, the middle
 * ndcToPixels({ x: -1, y: 1 }, 400, 300); // { x: 0, y: 0 }, the top left
 */
export function ndcToPixels({ x, y }, width, height) {
  return { x: ((x + 1) / 2) * width, y: ((1 - y) / 2) * height };
}

/**
 * How many CSS pixels one scene unit spans on the plane of the resting records.
 *
 * @param {number} height the stage's height in CSS pixels
 * @param {number} distance the camera's distance from that plane (`cameraDistance`)
 * @returns {number}
 * @example
 * pixelsPerUnit(400, 10); // about 52: a resting record (radius 0.58) is then 60 px wide
 */
export function pixelsPerUnit(height, distance) {
  return height / (2 * Math.tan(((CAMERA_FOV / 2) * Math.PI) / 180) * distance);
}

/**
 * Width of a title label: the pitch of the records minus a small gutter, so the titles of two
 * neighbours never touch.
 *
 * @param {number} unit CSS pixels per scene unit (`pixelsPerUnit`)
 * @returns {number} CSS pixels
 * @example
 * labelWidth(60); // 94, for a pitch of 102 px
 */
export function labelWidth(unit) {
  return Math.max(LABEL_MIN_WIDTH_PX, Math.round(RECORD_SPACING * unit - LABEL_GUTTER_PX));
}

/**
 * Height, in scene units, of the point a record's label hangs from: the record's lower rim.
 * The label's own gap and height are CSS, below this point.
 *
 * @param {number} recordY the record's centre height
 * @param {number} recordScale the record's size (radius), as it is now while it grows
 * @returns {number}
 * @example
 * labelAnchorY(0, 0.58); // -0.58
 */
export function labelAnchorY(recordY, recordScale) {
  return recordY - recordScale;
}

/**
 * How a title wider than its label scrolls: always to the left, like a ticker, so it reads from
 * left to right, and then again from its start. The label holds the title, a gap and a second
 * copy; the page's CSS moves them left by one title and one gap, where the second copy stands
 * exactly where the first began, so the loop starts over without a visible jump. Each loop
 * rests a moment on the first letters.
 *
 * @param {number} textWidth the title's width in pixels
 * @param {number} labelWidth the label's width in pixels
 * @returns {{shift: number, gap: number, duration: number} | null} `shift` in pixels (negative:
 *   to the left), `gap` in pixels, `duration` in seconds for one loop; null for a title that
 *   fits, which stays still
 * @example
 * marqueeTiming(60, 90); // null
 * marqueeTiming(146, 90); // { shift: -178, gap: 32, duration: 7.48... }
 */
export function marqueeTiming(textWidth, labelWidth) {
  if (textWidth - labelWidth < MARQUEE_MIN_OVERFLOW) return null;
  const distance = textWidth + MARQUEE_GAP;
  return { shift: -distance, gap: MARQUEE_GAP, duration: distance / MARQUEE_SPEED / MARQUEE_MOVING_SHARE };
}

/**
 * Seconds a label waits before its first slide, so neighbouring titles do not move in step.
 *
 * @param {number} index place on the page
 * @returns {number} from 0 to 2.5
 * @example
 * marqueeDelay(2); // 1
 */
export function marqueeDelay(index) {
  return (index % MARQUEE_STAGGER_PERIOD) * MARQUEE_STAGGER;
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

// --- Page turns and entrances -----------------------------------------------------------------
//
// When the page of records changes, the old records do not vanish and the new ones do not
// appear: a turn slides the old page out and the new page in, in the direction of the turn; a
// change of list (another playlist, a search) pops the new records in one after another. These
// functions give the pose of one record `elapsed` milliseconds into such a motion as an offset
// to add to its resting position (in scene units), an opacity, and a scale factor. The scene
// applies them to the records' groups every frame; they are numbers only, so they are tested
// without WebGL. Under reduced motion the scene skips them and swaps the page at once.

/** How long a page turn takes, in milliseconds. */
export const PAGE_TURN_MS = 220;

/** The wait between one record's entrance and the next's, and the longest wait (milliseconds). */
export const ENTER_STAGGER_MS = 18;
export const ENTER_STAGGER_MAX_MS = 300;

/** How far a record travels when a page turns, in scene units: a column and a half. */
const TURN_DISTANCE = RECORD_SPACING * 1.5;

/** @param {number} progress from 0 to 1 @returns {number} an ease-out cubic: fast at first, settling */
const easeOut = (progress) => 1 - (1 - progress) ** 3;

/** @param {number} elapsed @param {number} duration @returns {number} progress clamped to 0..1 */
const progressOf = (elapsed, duration) => Math.min(1, Math.max(0, elapsed / duration));

/**
 * The pose of a record that is arriving.
 *
 * With a direction (1: the next page, -1: the previous one) the record slides in from that side
 * while fading in. With 0 (the list changed) it stays in place and grows from half size, after a
 * wait of 18 ms per record before it (at most 300 ms), so a page fills in like a wave.
 *
 * @param {number} elapsed milliseconds since the page changed
 * @param {number} index the record's place on the page, from 0
 * @param {-1 | 0 | 1} direction
 * @returns {{offsetX: number, opacity: number, scale: number}} `scale` multiplies the record's own scale
 * @example
 * enterPose(0, 0, 1); // { offsetX: 2.55, opacity: 0, scale: 0.9 }: about to slide in from the right
 * enterPose(220, 0, 1); // { offsetX: 0, opacity: 1, scale: 1 }: settled
 */
export function enterPose(elapsed, index, direction) {
  if (direction === 0) {
    const wait = Math.min(index * ENTER_STAGGER_MS, ENTER_STAGGER_MAX_MS);
    const eased = easeOut(progressOf(elapsed - wait, PAGE_TURN_MS));
    return { offsetX: 0, opacity: eased, scale: 0.5 + 0.5 * eased };
  }
  const eased = easeOut(progressOf(elapsed, PAGE_TURN_MS));
  return { offsetX: direction * TURN_DISTANCE * (1 - eased) + 0, opacity: eased, scale: 0.9 + 0.1 * eased };
}

/**
 * The pose of a record that is leaving: it slides away from the side the new page comes from,
 * fading out.
 *
 * @param {number} elapsed milliseconds since the page changed
 * @param {-1 | 1} direction 1 when turning to the next page (the old records go left)
 * @returns {{offsetX: number, opacity: number, scale: number}}
 * @example
 * exitPose(220, 1); // { offsetX: -2.55, opacity: 0, scale: 0.9 }
 */
export function exitPose(elapsed, direction) {
  const eased = easeOut(progressOf(elapsed, PAGE_TURN_MS));
  return { offsetX: -direction * TURN_DISTANCE * eased + 0, opacity: 1 - eased, scale: 1 - 0.1 * eased };
}
