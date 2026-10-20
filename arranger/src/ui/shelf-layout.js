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

/** Scale of a resting record and of the selected one (a record has radius 1 at scale 1). */
const RESTING_SCALE = 0.58;
const SELECTED_SCALE = 0.92;

/** How far the selected record comes toward the camera and rises. */
const SELECTED_FORWARD = 1.1;
const SELECTED_RISE = 0.12;

/** Height of the bob, and the resting records' slight turn toward the light. */
const BOB_HEIGHT = 0.05;
const RESTING_TILT = 0.2;

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
  const neededHeight = (SHELF_ROWS - 1) * RECORD_SPACING + HALO_SCALE + 0.5;
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
      tilt: reducedMotion ? 0 : Math.sin(time * 1.2) * 0.45,
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
