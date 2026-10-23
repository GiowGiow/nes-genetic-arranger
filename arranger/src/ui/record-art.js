// @ts-check
/**
 * Record art: the face of a vinyl record, as a 128×128 picture.
 *
 * The shelf shows every catalog song as a record, and the Result shows the song that was
 * arranged as a record on a turntable. They must be the same record, so both draw its face with
 * this one function: a dark disc, concentric grooves, a short bright arc of light caught in them,
 * a label in one of the four channel colors with the song's 16×16 sprite on it, and the spindle
 * hole. The sprite and its colors come from the song's catalog entry (`sprites.js`), so a song
 * always has the same face.
 *
 * The picture is drawn at the size it is shown, never scaled up smooth: three.js then samples it
 * with nearest-neighbour filtering, which keeps the chunky pixel look.
 */

import { drawSprite, entrySprite } from "./sprites.js";

/** Size of a record's face texture, in pixels. */
export const RECORD_FACE_SIZE = 128;

/** Canvas pixels per cell of the sprite on the label (16 cells make 48 pixels). */
export const SPRITE_SCALE = 3;

/**
 * Paint a record's face on a canvas, which is resized to 128×128.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{seed?: number, facts?: {key?: string}}} entry the song's catalog entry (or the record
 *   of an opened file): its seed picks the figure and its key the colors
 * @returns {HTMLCanvasElement} the same canvas, ready to be a texture
 * @example
 * const texture = new THREE.CanvasTexture(drawRecordFace(document.createElement("canvas"), entry));
 */
export function drawRecordFace(canvas, entry) {
  canvas.width = RECORD_FACE_SIZE;
  canvas.height = RECORD_FACE_SIZE;
  const context = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  const centre = RECORD_FACE_SIZE / 2;
  const disc = (/** @type {number} */ radius, /** @type {string} */ color) => {
    context.fillStyle = color;
    context.beginPath();
    context.arc(centre, centre, radius, 0, Math.PI * 2);
    context.fill();
  };
  disc(centre, "#0b0d14");
  context.lineWidth = 1;
  for (let radius = 61; radius > 31; radius -= 2) {
    context.strokeStyle = radius % 4 ? "#151925" : "#1e2333";
    context.beginPath();
    context.arc(centre, centre, radius, 0, Math.PI * 2);
    context.stroke();
  }
  // A short bright arc reads as light caught in the grooves.
  context.strokeStyle = "rgba(200, 215, 255, .28)";
  context.lineWidth = 3;
  context.beginPath();
  context.arc(centre, centre, 52, -0.9, -0.3);
  context.stroke();
  const sprite = entrySprite(entry);
  disc(28, sprite.label);
  const spriteSize = 16 * SPRITE_SCALE;
  drawSprite(context, sprite, centre - spriteSize / 2, centre - spriteSize / 2, SPRITE_SCALE);
  disc(2, "#000000");
  return canvas;
}
