// @ts-check
/**
 * Turntable 2D: the Result's record player drawn on a canvas, seen from above.
 *
 * It is the first picture the visitor sees (the three.js scene needs about 800 KB and waits for
 * the browser to be idle) and the only one when the browser has no WebGL. It draws the same
 * things as the 3D scene from the same numbers (`turntable-geometry.js`): a plinth, a platter
 * with a ring of strobe dots, the record's face turning, and the tonearm, with a lamp that is lit
 * while the motor runs. The record's face is drawn without smoothing, so it keeps the chunky
 * pixel look of the shelf's records.
 *
 * The scene's plane has x to the right and z toward the viewer, the spindle at the origin; `fitView`
 * scales and centers it on the canvas, and `canvasToPlane` maps a pointer back for the drag.
 */

import { ARM_PIVOT, RECORD_RADIUS, armTip } from "./turntable-geometry.js";

/** What the picture covers, in scene units: the plinth with a margin. */
export const VIEW_BOUNDS = Object.freeze({ minX: -1.4, maxX: 2.0, minZ: -1.55, maxZ: 1.4 });

/** The plinth (the wooden base) and the platter, in scene units. */
const PLINTH = Object.freeze({ minX: -1.3, maxX: 1.9, minZ: -1.45, maxZ: 1.3 });
const PLATTER_RADIUS = 1.1;

/**
 * How the plane fits a canvas.
 *
 * @param {number} width canvas width in CSS pixels
 * @param {number} height
 * @returns {{scale: number, left: number, top: number}} pixels per scene unit, and the canvas
 *   position of the plane's minimum corner
 * @example
 * fitView(660, 550).scale; // 200 pixels per unit
 */
export function fitView(width, height) {
  const spanX = VIEW_BOUNDS.maxX - VIEW_BOUNDS.minX;
  const spanZ = VIEW_BOUNDS.maxZ - VIEW_BOUNDS.minZ;
  const scale = Math.min(width / spanX, height / spanZ);
  return {
    scale,
    left: (width - spanX * scale) / 2,
    top: (height - spanZ * scale) / 2,
  };
}

/**
 * @param {{scale: number, left: number, top: number}} view
 * @param {{x: number, z: number}} point in scene units
 * @returns {{x: number, y: number}} canvas pixels
 */
export function planeToCanvas(view, { x, z }) {
  return { x: view.left + (x - VIEW_BOUNDS.minX) * view.scale, y: view.top + (z - VIEW_BOUNDS.minZ) * view.scale };
}

/**
 * @param {{scale: number, left: number, top: number}} view
 * @param {{x: number, y: number}} pixel canvas pixels
 * @returns {{x: number, z: number}} scene units
 */
export function canvasToPlane(view, { x, y }) {
  return { x: (x - view.left) / view.scale + VIEW_BOUNDS.minX, z: (y - view.top) / view.scale + VIEW_BOUNDS.minZ };
}

/**
 * Make the 2D renderer inside `host`.
 *
 * @param {HTMLElement} host
 * @returns {import("./turntable-view.js").TurntableRenderer}
 */
export function createTurntable2d(host) {
  const canvas = host.ownerDocument.createElement("canvas");
  canvas.className = "turntable-canvas";
  host.append(canvas);
  const context = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  /** @type {HTMLCanvasElement | null} */
  let face = null;
  let width = 0;
  let height = 0;
  let ratio = 1;
  let view = fitView(1, 1);

  return {
    canvas,
    resize(newWidth, newHeight, newRatio) {
      width = newWidth;
      height = newHeight;
      ratio = newRatio;
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      view = fitView(width, height);
    },
    setRecord(newFace) {
      face = newFace;
    },
    planePoint(clientX, clientY) {
      const box = canvas.getBoundingClientRect();
      return canvasToPlane(view, { x: clientX - box.left, y: clientY - box.top });
    },
    draw({ spinAngle, armAngle, lift, playing }) {
      if (!width || !height) return;
      const unit = view.scale;
      const at = (/** @type {number} */ x, /** @type {number} */ z) => planeToCanvas(view, { x, z });
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      // Plinth: a dark base with a lighter top edge.
      const corner = at(PLINTH.minX, PLINTH.minZ);
      const sizeX = (PLINTH.maxX - PLINTH.minX) * unit;
      const sizeZ = (PLINTH.maxZ - PLINTH.minZ) * unit;
      context.fillStyle = "#151a28";
      roundRect(context, corner.x, corner.y, sizeX, sizeZ, unit * 0.12);
      context.fill();
      context.strokeStyle = "rgba(160, 175, 210, .22)";
      context.lineWidth = 1.5;
      context.stroke();

      // Platter, with strobe dots on its rim turning with the record.
      const centre = at(0, 0);
      context.fillStyle = "#262d40";
      context.beginPath();
      context.arc(centre.x, centre.y, PLATTER_RADIUS * unit, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = "rgba(207, 207, 207, .45)";
      for (let dot = 0; dot < 48; dot += 1) {
        const angle = spinAngle + (dot / 48) * Math.PI * 2;
        context.fillRect(centre.x + Math.cos(angle) * PLATTER_RADIUS * 0.96 * unit - 1, centre.y + Math.sin(angle) * PLATTER_RADIUS * 0.96 * unit - 1, 2, 2);
      }

      // The record: its face without smoothing, turning clockwise as seen from above.
      context.save();
      context.translate(centre.x, centre.y);
      context.rotate(spinAngle);
      if (face) {
        context.imageSmoothingEnabled = false;
        context.drawImage(face, -RECORD_RADIUS * unit, -RECORD_RADIUS * unit, RECORD_RADIUS * 2 * unit, RECORD_RADIUS * 2 * unit);
      } else {
        context.fillStyle = "#0b0d14";
        context.beginPath();
        context.arc(0, 0, RECORD_RADIUS * unit, 0, Math.PI * 2);
        context.fill();
      }
      context.restore();
      context.fillStyle = "#cfcfcf";
      context.beginPath();
      context.arc(centre.x, centre.y, unit * 0.035, 0, Math.PI * 2);
      context.fill();

      // The motor lamp.
      const lamp = at(1.6, 1.0);
      context.fillStyle = playing ? "#ff800e" : "#3a3f50";
      context.beginPath();
      context.arc(lamp.x, lamp.y, unit * 0.05, 0, Math.PI * 2);
      context.fill();

      drawArm(context, view, armAngle, lift);
    },
    dispose() {
      canvas.remove();
    },
  };
}

/** @param {CanvasRenderingContext2D} context @param {{scale: number, left: number, top: number}} view @param {number} angle @param {number} lift */
function drawArm(context, view, angle, lift) {
  const unit = view.scale;
  const pivot = planeToCanvas(view, ARM_PIVOT);
  const tip = planeToCanvas(view, armTip(angle));
  const back = planeToCanvas(view, {
    x: ARM_PIVOT.x - Math.cos(angle) * 0.35,
    z: ARM_PIVOT.z - Math.sin(angle) * 0.35,
  });
  // A raised arm casts a longer, fainter shadow beside it.
  const shadow = lift * unit * 0.1;
  context.lineCap = "round";
  context.strokeStyle = `rgba(0, 0, 0, ${0.35 - lift * 0.15})`;
  context.lineWidth = unit * 0.06;
  context.beginPath();
  context.moveTo(back.x + shadow, back.y + shadow);
  context.lineTo(tip.x + shadow, tip.y + shadow);
  context.stroke();

  context.strokeStyle = "#cfcfcf";
  context.lineWidth = unit * 0.045;
  context.beginPath();
  context.moveTo(back.x, back.y);
  context.lineTo(tip.x, tip.y);
  context.stroke();

  // Counterweight, pivot cap and the headshell with the needle's glint.
  context.fillStyle = "#8d94a8";
  context.beginPath();
  context.arc(back.x, back.y, unit * 0.09, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#5f9ed1";
  context.beginPath();
  context.arc(pivot.x, pivot.y, unit * 0.1, 0, Math.PI * 2);
  context.fill();
  context.save();
  context.translate(tip.x, tip.y);
  context.rotate(angle);
  context.fillStyle = "#ffbc79";
  context.fillRect(-unit * 0.04, -unit * 0.07, unit * 0.2, unit * 0.14);
  context.restore();
}

/** @param {CanvasRenderingContext2D} context @param {number} x @param {number} y @param {number} width @param {number} height @param {number} radius */
function roundRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}
