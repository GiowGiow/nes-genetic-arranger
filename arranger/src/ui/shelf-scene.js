// @ts-check
/**
 * Shelf scene: the 3D view of one catalog page, drawn with three.js (spec 005, story 3,
 * research R6). It is the only module that imports three.js, and `song-shelf.js` loads it only
 * when the browser has WebGL 2.
 *
 * The scene draws the state the shelf owns; it holds none of its own beyond the animation:
 *
 * - **Records.** Each song is a thin disc whose faces carry a 128×128 canvas texture: dark
 *   grooves, a highlight, a label in one of the four channel colors and the song's 16×16
 *   sprite on it. Textures use nearest-neighbour filtering and the canvas renders at 0.6× the
 *   device's pixels, so the pixel art stays crisp and blocky.
 * - **Motion.** `shelf-layout.js` gives every record's pose at each moment: the others bob, the
 *   selected one comes forward, grows, sways and spins like a turntable, with an additive halo
 *   behind it. Under reduced motion every pose is still.
 * - **Page turns.** Turning a page slides the records of the old page out, fading, while those
 *   of the new page slide in from the side of the turn; a change of list (a playlist, a search)
 *   pops the new records in one after another (`shelf-layout.js` `enterPose`, `exitPose`).
 *   The labels follow their records. Reduced motion swaps the page at once.
 * - **Faces are remembered.** A record's face texture is drawn once per song and kept in a small
 *   least-recently-used cache (`texture-cache.js`), and the shelf asks the scene to draw the
 *   faces of the neighbouring pages while the browser is idle, so a turn does not hitch.
 * - **Titles.** Under each record hangs its title as a page element, not as a texture: the canvas
 *   renders at about half the device's pixels, which blurred painted letters. The scene creates a
 *   layer of labels inside its host (`.shelf-labels`, hidden from assistive technology: the
 *   shelf's listbox names the songs). Every frame it projects each record's lower rim to the
 *   stage's pixels (`vector.project(camera)`) and moves the label there, writing a label's style
 *   only when it moved. The page's UI font and CSS do the rest: a title wider than its label
 *   slides back and forth (the scene measures the overflow and passes it to the CSS animation as
 *   custom properties), and under reduced motion it is cut with an ellipsis. The selected
 *   record's label is brighter. A click on a label picks its record, like a click on the disc.
 * - **Glow behind, always.** The halo is not "transparent" for three.js, so it joins the opaque
 *   list, where `renderOrder = -1` draws it before every record; the records then paint over it
 *   wherever they overlap, however the selected one sways.
 * - **Cheap on a phone.** The loop is our own `requestAnimationFrame`: it caps at 30 fps on touch
 *   or narrow screens, lowers the pixel ratio there, and stops asking for frames while the page
 *   is hidden or the stage is off screen. Under reduced motion it draws only after a change.
 * - **Light and air.** An ambient light, a white key light and two soft rim lights in the P1
 *   blue and the P2 orange; about 90 faint particles in the four channel colors drift slowly.
 * - **No box.** The canvas is transparent (`alpha`), so the records float over the Song
 *   card's glass and glow, with no sky or border of their own.
 *
 * When the GPU drops the context, the browser fires `webglcontextlost` at the canvas; the shelf
 * catches it on the canvas host as it descends and replaces the scene with its 2D grid.
 */

// @ts-ignore: "three" resolves through the page's import map (vendor/three/), not on disk.
import * as THREE from "three";

import { createRandom } from "../core/random.js";
import { displayTitle } from "../core/sources.js";
import {
  CAMERA_FOV,
  ENTER_STAGGER_MAX_MS,
  HALO_SCALE,
  PAGE_TURN_MS,
  cameraDistance,
  enterPose,
  exitPose,
  haloOpacity,
  isLowPower,
  labelAnchorY,
  labelWidth,
  marqueeDelay,
  marqueeTiming,
  ndcToPixels,
  pixelRatioFor,
  pixelsPerUnit,
  recordPose,
  scaleEasing,
  shelfColumns,
  shouldRenderFrame,
  targetFps,
} from "./shelf-layout.js";
import { CHANNEL_COLORS, drawSprite, entrySprite } from "./sprites.js";
import { createTextureCache } from "./texture-cache.js";

/** Faint particles drifting behind the records. */
const PARTICLE_COUNT = 90;
const PARTICLE_SEED = 5;

/** Size of a record's face texture, in pixels, and of the sprite on its label (3 px a cell). */
const TEXTURE_SIZE = 128;
const SPRITE_SCALE = 3;

/** How many faces to remember: two pages of the widest shelf (27 records) and some to spare. */
const FACE_LIMIT = 90;

/** How many faces to draw in one idle period when preparing the neighbouring pages. */
const PRELOAD_BATCH = 3;

/** The most departing records kept at once; a visitor flicking through pages does not pile them up. */
const MAX_DEPARTING = 54;

/** The longest an entrance can last: the longest wait (300 ms) and the pop itself. */
const ENTRANCE_MS = ENTER_STAGGER_MAX_MS + PAGE_TURN_MS;

/** @param {CatalogEntry} entry @returns {string} the key a face is remembered under */
const faceKey = (entry) => `${entry.source}:${entry.id}`;

/** @typedef {import("../core/sources.js").CatalogEntry} CatalogEntry */
/** @typedef {import("./song-shelf.js").ShelfScene} ShelfScene */

/**
 * A canvas texture shown pixel for pixel.
 *
 * @param {HTMLCanvasElement} canvas
 * @returns {any} a THREE.CanvasTexture
 */
function pixelTexture(canvas) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * The face of a record: grooves, a highlight, the label in a channel color and the sprite.
 *
 * @param {CatalogEntry} entry
 * @returns {any} a THREE.CanvasTexture
 */
function recordTexture(entry) {
  const canvas = document.createElement("canvas");
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;
  const context = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  const centre = TEXTURE_SIZE / 2;
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
  return pixelTexture(canvas);
}

/**
 * A soft radial glow, drawn once, shown behind the selected record.
 *
 * @returns {any} a THREE.Sprite
 */
function makeHalo() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  const glow = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  glow.addColorStop(0, "rgba(140, 190, 240, .55)");
  glow.addColorStop(0.45, "rgba(95, 158, 209, .16)");
  glow.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = glow;
  context.fillRect(0, 0, 64, 64);
  // Not "transparent": three.js draws opaque objects first, sorted by renderOrder, and the
  // transparent ones after all of them. A transparent halo would be painted over the part of the
  // selected record that sways behind it. As an opaque-list object with additive blending (which
  // three.js applies whatever `transparent` says) and no depth write, it is drawn first, and the
  // records, which are opaque, simply cover it.
  const material = new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(canvas),
    blending: THREE.AdditiveBlending,
    transparent: false,
    depthWrite: false,
  });
  const halo = new THREE.Sprite(material);
  halo.renderOrder = -1;
  halo.scale.set(HALO_SCALE, HALO_SCALE, 1);
  return halo;
}

/**
 * Faint particles in the four channel colors, placed by the app's seeded generator.
 *
 * @returns {any} a THREE.Points
 */
function makeParticles() {
  const random = createRandom(PARTICLE_SEED);
  const positions = new Float32Array(PARTICLE_COUNT * 3);
  const colors = new Float32Array(PARTICLE_COUNT * 3);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    positions.set([(random.float() - 0.5) * 16, (random.float() - 0.5) * 8, -random.float() * 6 - 1], i * 3);
    const color = new THREE.Color(CHANNEL_COLORS[i % CHANNEL_COLORS.length]);
    colors.set([color.r, color.g, color.b], i * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    size: 0.05,
    vertexColors: true,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  return new THREE.Points(geometry, material);
}

/**
 * Build the scene inside `host` (the shelf's canvas host) and start drawing.
 *
 * @param {HTMLElement} host an element that fills the shelf's stage
 * @param {{reducedMotion: boolean}} options
 * @returns {ShelfScene}
 * @throws {Error} when the browser cannot create a WebGL 2 context (the shelf then shows 2D)
 * @example
 * const scene = createShelfScene(host, { reducedMotion: false });
 * scene.onPick((index) => shelf.select(pageStart + index));
 * scene.setPage(pageEntries, 0, 5);
 */
export function createShelfScene(host, options) {
  /** Can change while the page is open: the visitor may switch the system setting. */
  let reducedMotion = options.reducedMotion;
  const canvas = document.createElement("canvas");
  host.append(canvas);
  /** @type {any} */
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true });
  } catch (error) {
    canvas.remove();
    throw error;
  }
  renderer.setClearColor(0x000000, 0);
  const coarsePointer = Boolean(globalThis.matchMedia?.("(pointer: coarse)").matches);
  let lowPower = isLowPower({ coarsePointer, width: host.clientWidth });
  let pixelRatio = pixelRatioFor(globalThis.devicePixelRatio, lowPower);
  renderer.setPixelRatio(pixelRatio);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 100);
  scene.add(new THREE.AmbientLight(0x8090b0, 0.55));
  /** @type {Array<[number, number, [number, number, number]]>} color, intensity, position */
  const directional = [
    [0xffffff, 1.3, [2, 4, 6]], // key light
    [0x5f9ed1, 0.9, [-6, 2, 1]], // P1 blue rim
    [0xff800e, 0.7, [6, -2, 1]], // P2 orange rim
  ];
  for (const [color, intensity, [x, y, z]] of directional) {
    const light = new THREE.DirectionalLight(color, intensity);
    light.position.set(x, y, z);
    scene.add(light);
  }
  const particles = makeParticles();
  const halo = makeHalo();
  const records = new THREE.Group();
  scene.add(particles, halo, records);

  // The titles: one element per record, in a layer over the canvas. Pixel positions are all
  // the layer needs; it is `aria-hidden` because the shelf's listbox names the songs.
  const labelLayer = document.createElement("div");
  labelLayer.className = "shelf-labels";
  labelLayer.setAttribute("aria-hidden", "true");
  host.append(labelLayer);
  /** @type {Array<{element: HTMLElement, text: HTMLElement, x: number, y: number}>} */
  let labels = [];
  /** The stage's size in CSS pixels, read when it changes, never per frame. */
  let stageWidth = 0;
  let stageHeight = 0;
  /** The width of a label in CSS pixels, set with the stage's size. */
  let labelWidthPx = 0;
  const anchor = new THREE.Vector3();

  const discGeometry = new THREE.CylinderGeometry(1, 1, 0.05, 28);

  // A face is drawn once per song and kept; it is released (its GPU texture freed) when it falls
  // out of the cache and no record on screen holds it.
  const faces = createTextureCache({
    limit: FACE_LIMIT,
    make: (_key, entry) => recordTexture(entry),
    release: (texture) => texture.dispose(),
  });

  let selected = 0;
  let columns = 5;
  /** @type {((index: number) => void) | null} */
  let picked = null;

  /**
   * Records that have left the page and are sliding away; their labels slide with them. They are
   * not in `records`, so a click cannot pick them.
   * @type {Array<{group: any, label: any, born: number, direction: -1 | 1, x: number, y: number, z: number, scale: number}>}
   */
  const departing = [];
  /** A page that is changing, so the records that arrive know which way to come from. */
  let arrival = /** @type {{direction: -1 | 0 | 1} | null} */ (null);

  /** Free what a record group holds: its materials, and the hold on its face. */
  function disposeGroup(/** @type {any} */ group) {
    const [edge, face] = group.children[0].material;
    faces.unhold(face.map);
    face.dispose();
    edge.dispose();
  }

  /** Remove everything on screen at once: the page, the departing records and their labels. */
  function clearRecords() {
    for (const group of [...records.children]) {
      disposeGroup(group);
      records.remove(group);
    }
    for (const gone of departing.splice(0)) {
      disposeGroup(gone.group);
      scene.remove(gone.group);
    }
    labelLayer.replaceChildren();
    labels = [];
  }

  /**
   * Let the current page's records slide away instead of vanishing. Their pose is kept as it was
   * on the last frame; the record goes to `departing` and its label stays in the layer.
   *
   * @param {-1 | 1} direction 1 when turning to the next page
   * @param {number} now
   */
  function retireRecords(direction, now) {
    records.children.forEach((/** @type {any} */ group, /** @type {number} */ index) => {
      departing.push({
        group,
        label: labels[index],
        born: now,
        direction,
        x: group.position.x,
        y: group.position.y,
        z: group.position.z,
        scale: group.scale.x,
      });
    });
    for (const gone of departing) {
      scene.add(gone.group); // moves it out of `records`
      gone.label.element.style.pointerEvents = "none"; // a click on a title leaving cannot pick it
    }
    // Too many departing records at once (a visitor holding the arrow): drop the oldest at once.
    while (departing.length > MAX_DEPARTING) {
      const oldest = /** @type {NonNullable<(typeof departing)[number]>} */ (departing.shift());
      disposeGroup(oldest.group);
      scene.remove(oldest.group);
      oldest.label.element.remove();
    }
    labels = [];
  }

  /**
   * The title label of a record: a clipped box with the title inside. Whether the title slides
   * is decided later (`measureLabels`), once the box has a width.
   *
   * @param {CatalogEntry} entry
   * @param {number} index
   */
  function makeLabel(entry, index) {
    const element = document.createElement("div");
    element.className = "shelf-label";
    // The track moves; it holds the title and a copy that shows only while the title scrolls,
    // so the loop can start over without a jump (see `marqueeTiming`).
    const track = document.createElement("span");
    track.className = "shelf-label-track";
    const text = document.createElement("span");
    text.className = "shelf-label-text";
    text.textContent = displayTitle(entry.t);
    const copy = document.createElement("span");
    copy.className = "shelf-label-copy";
    copy.textContent = text.textContent;
    track.append(text, copy);
    element.append(track);
    element.style.setProperty("--marquee-delay", `${marqueeDelay(index)}s`);
    element.addEventListener("click", () => picked?.(index));
    labelLayer.append(element);
    return { element, text, track, x: Number.NaN, y: Number.NaN };
  }

  /**
   * Mark which label is the selected one: it is brighter, and a long title starts over from its
   * first letters, so the visitor can read it from the start.
   */
  function markSelectedLabel() {
    labels.forEach(({ element, track }, index) => {
      const on = index === selected;
      if (element.classList.contains("is-selected") === on) return;
      element.classList.toggle("is-selected", on);
      if (on && element.classList.contains("is-long")) {
        track.style.animation = "none";
        void track.offsetWidth; // a reflow, so the animation really restarts when it is given back
        track.style.animation = "";
      }
    });
  }

  /**
   * Find which titles are wider than their label and set how they slide. Reads first, writes
   * after, so the page lays out once. Under reduced motion nothing slides: the CSS cuts the
   * title with an ellipsis, so there is nothing to measure.
   */
  function measureLabels() {
    if (reducedMotion || !labelLayer.clientWidth) return;
    const widths = labels.map(({ element, text }) => [text.offsetWidth, element.clientWidth]);
    labels.forEach(({ element }, index) => {
      const timing = marqueeTiming(widths[index][0], widths[index][1]);
      element.classList.toggle("is-long", timing !== null);
      if (!timing) return;
      element.style.setProperty("--marquee-shift", `${timing.shift}px`);
      element.style.setProperty("--marquee-gap", `${timing.gap}px`);
      element.style.setProperty("--marquee-duration", `${timing.duration.toFixed(2)}s`);
    });
  }

  /**
   * Move a label to its place under a record; the style is written only when the position
   * changed, which saves the browser a style recalculation per label per frame.
   *
   * @param {{element: HTMLElement, x: number, y: number}} label
   * @param {number} x the centre of the label, in stage pixels
   * @param {number} y the top of the label
   */
  function placeLabel(label, x, y) {
    const left = Math.round(x - labelWidthPx / 2);
    const top = Math.round(y);
    if (label.x === left && label.y === top) return;
    label.x = left;
    label.y = top;
    label.element.style.transform = `translate(${left}px, ${top}px)`;
  }
  /** @param {CatalogEntry} entry @param {number} index @param {number} born when the record arrived */
  function makeRecord(entry, index, born) {
    const texture = faces.get(faceKey(entry), entry);
    faces.hold(texture);
    const face = new THREE.MeshPhongMaterial({ map: texture, shininess: 25, specular: 0x111622 });
    // Each record has its own rim material, so a record can fade out without its neighbours.
    const edge = new THREE.MeshPhongMaterial({ color: 0x07080c, shininess: 20 });
    // A cylinder's materials are [side, top, bottom]: both faces show the label.
    const disc = new THREE.Mesh(discGeometry, [edge, face, face]);
    disc.rotation.x = Math.PI / 2;
    const group = new THREE.Group();
    group.add(disc);
    group.userData.index = index;
    group.userData.born = born;
    group.userData.direction = arrival?.direction ?? 0;
    group.userData.entering = Boolean(arrival);
    group.scale.setScalar(0.62);
    return group;
  }

  /**
   * Fade a record: its two materials become see-through while it moves, and opaque again after.
   * three.js compiles an opaque material with the alpha forced to 1, so switching between the two
   * needs `needsUpdate` (the programs are cached, so each is compiled once).
   *
   * @param {any} group
   * @param {number} opacity 1 for opaque
   */
  function setOpacity(group, opacity) {
    const [edge, face] = group.children[0].material;
    const fading = opacity < 1;
    for (const material of [edge, face]) {
      if (material.transparent !== fading) {
        material.transparent = fading;
        material.needsUpdate = true;
      }
      material.opacity = opacity;
    }
  }

  /**
   * Draw the faces of some songs ahead of need, a few at a time while the browser is idle, so
   * turning to those pages finds them ready.
   *
   * @param {CatalogEntry[]} entries
   */
  function preload(entries) {
    const queue = entries.filter((entry) => !faces.has(faceKey(entry)));
    const later = /** @type {(run: () => void) => void} */ (
      (run) => (globalThis.requestIdleCallback ? globalThis.requestIdleCallback(() => run()) : setTimeout(run, 50))
    );
    const step = () => {
      if (disposed) return;
      for (const entry of queue.splice(0, PRELOAD_BATCH)) faces.get(faceKey(entry), entry);
      if (queue.length > 0) later(step);
    };
    if (queue.length > 0) later(step);
  }

  function resize() {
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (!width || !height) return;
    lowPower = isLowPower({ coarsePointer, width });
    const ratio = pixelRatioFor(globalThis.devicePixelRatio, lowPower);
    if (ratio !== pixelRatio) {
      pixelRatio = ratio;
      renderer.setPixelRatio(ratio);
    }
    renderer.setSize(width, height, false);
    stageWidth = width;
    stageHeight = height;
    camera.aspect = width / height;
    const distance = cameraDistance(columns, camera.aspect);
    camera.position.set(0, 0, distance);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(); // labels are projected before the first render
    labelWidthPx = labelWidth(pixelsPerUnit(height, distance));
    labelLayer.style.setProperty("--label-width", `${labelWidthPx}px`);
    measureLabels();
    labels.forEach((label) => (label.x = Number.NaN)); // the width changed: place every label again
    requestRender();
  }

  /**
   * A label's opacity, written only when it changed (like its position).
   *
   * @param {{element: HTMLElement, opacity?: number}} label
   * @param {number} opacity
   */
  function setLabelOpacity(label, opacity) {
    const rounded = Math.round(opacity * 20) / 20;
    if ((label.opacity ?? 1) === rounded) return;
    label.opacity = rounded;
    label.element.style.opacity = rounded === 1 ? "" : String(rounded);
  }

  /**
   * Put the records, their labels and the glow where they belong at a moment, and draw.
   *
   * @param {number} timestamp milliseconds, from `requestAnimationFrame`
   * @param {number} elapsed milliseconds since the last drawn frame
   */
  function draw(timestamp, elapsed) {
    const time = timestamp / 1000;
    const ease = scaleEasing(elapsed);
    records.children.forEach((/** @type {any} */ group, /** @type {number} */ index) => {
      const pose = recordPose(index, { selected: index === selected, columns, time, reducedMotion });
      // A record that has just arrived slides or pops in (`enterPose`); once settled it is plain.
      let offsetX = 0;
      let entrance = 1;
      let arriving = false;
      if (group.userData.entering && !reducedMotion) {
        const since = timestamp - group.userData.born;
        const entry = enterPose(since, index, group.userData.direction);
        offsetX = entry.offsetX;
        entrance = entry.scale;
        arriving = since < ENTRANCE_MS;
        setOpacity(group, arriving ? entry.opacity : 1);
        if (!arriving) group.userData.entering = false;
      }
      group.position.set(pose.x + offsetX, pose.y, pose.z);
      group.rotation.y = pose.tilt;
      if (pose.spin !== null) group.children[0].rotation.y = pose.spin;
      const scale = reducedMotion ? pose.scale : arriving ? pose.scale * entrance : THREE.MathUtils.lerp(group.scale.x, pose.scale, ease);
      group.scale.setScalar(scale);
      const label = labels[index];
      if (label) {
        anchor.set(pose.x + offsetX, labelAnchorY(pose.y, scale), pose.z).project(camera);
        const { x, y } = ndcToPixels(anchor, stageWidth, stageHeight);
        placeLabel(label, x, y);
        setLabelOpacity(label, arriving ? group.children[0].material[1].opacity : 1);
      }
    });
    // Records of the page being left slide away, fading, and are freed when they are gone.
    for (let i = departing.length - 1; i >= 0; i -= 1) {
      const gone = departing[i];
      const since = timestamp - gone.born;
      if (since >= PAGE_TURN_MS) {
        disposeGroup(gone.group);
        scene.remove(gone.group);
        gone.label.element.remove();
        departing.splice(i, 1);
        continue;
      }
      const exit = exitPose(since, gone.direction);
      gone.group.position.set(gone.x + exit.offsetX, gone.y, gone.z);
      gone.group.scale.setScalar(gone.scale * exit.scale);
      setOpacity(gone.group, exit.opacity);
      anchor.set(gone.x + exit.offsetX, labelAnchorY(gone.y, gone.scale * exit.scale), gone.z).project(camera);
      const { x, y } = ndcToPixels(anchor, stageWidth, stageHeight);
      placeLabel(gone.label, x, y);
      setLabelOpacity(gone.label, exit.opacity);
    }
    const current = records.children[selected];
    halo.visible = Boolean(current);
    if (current) {
      halo.position.set(current.position.x, current.position.y, current.position.z - 0.3);
      halo.material.opacity = haloOpacity(time, reducedMotion);
    }
    if (!reducedMotion) particles.rotation.y = Math.sin(time * 0.05) * 0.2;
    renderer.render(scene, camera);
  }

  // ---- The loop: draw only what is worth the battery ----
  let onScreen = true; // the host is inside the viewport (IntersectionObserver)
  let dirty = true; // something changed since the last drawn frame
  let lastDrawn = Number.NEGATIVE_INFINITY;
  let handle = 0; // the pending requestAnimationFrame, 0 for none

  const isVisible = () => document.visibilityState !== "hidden" && onScreen && host.clientWidth > 0;

  function requestRender() {
    dirty = true;
    schedule();
  }

  function schedule() {
    if (!handle) handle = requestAnimationFrame(tick);
  }

  /** @param {number} timestamp */
  function tick(timestamp) {
    handle = 0;
    const visible = isVisible();
    if (shouldRenderFrame({ visible, animated: !reducedMotion, dirty, now: timestamp, last: lastDrawn, fps: targetFps(lowPower) })) {
      draw(timestamp, timestamp - lastDrawn);
      lastDrawn = timestamp;
      dirty = false;
    }
    // Hidden: stop asking for frames; the observers below wake the loop. Without an
    // IntersectionObserver the loop keeps polling, as it did before.
    if (!reducedMotion && (visible || !observer)) schedule();
  }

  /** @type {IntersectionObserver | null} */
  const observer =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
          onScreen = entries[entries.length - 1].isIntersecting;
          if (onScreen) requestRender();
        })
      : null;
  observer?.observe(host);
  const onVisibility = () => {
    if (document.visibilityState !== "hidden") requestRender();
  };
  document.addEventListener("visibilitychange", onVisibility);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  /** @param {MouseEvent} event */
  function onClick(event) {
    const box = canvas.getBoundingClientRect();
    pointer.set(((event.clientX - box.left) / box.width) * 2 - 1, -((event.clientY - box.top) / box.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(records.children, true)[0];
    if (!hit) return;
    let object = hit.object;
    while (object.parent !== records) object = object.parent;
    picked?.(object.userData.index);
  }
  canvas.addEventListener("click", onClick);

  // A title measured before the page font arrives is narrower than it will be.
  globalThis.document?.fonts?.ready.then(measureLabels);

  // A title measured before the page font arrives is narrower than it will be.
  globalThis.document?.fonts?.ready.then(measureLabels);

  requestRender();

  let disposed = false;

  return {
    setPage(entries, selectedIndex, pageColumns, motion) {
      const now = performance.now();
      const animate = !reducedMotion && motion !== undefined && records.children.length > 0;
      if (animate && motion.direction !== 0) {
        // Turning: the old page slides away; its labels stay until it is gone.
        retireRecords(/** @type {-1 | 1} */ (motion.direction), now);
      } else {
        clearRecords();
      }
      arrival = reducedMotion || motion === undefined ? null : { direction: motion.direction };
      for (const [index, entry] of entries.entries()) {
        records.add(makeRecord(entry, index, now));
        labels.push(makeLabel(entry, index));
      }
      arrival = null;
      selected = selectedIndex;
      columns = pageColumns ?? shelfColumns(host.clientWidth);
      markSelectedLabel();
      resize();
      requestRender();
    },
    preload,
    setReducedMotion(reduced) {
      reducedMotion = reduced;
      measureLabels();
      requestRender();
    },
    select(index) {
      selected = index;
      markSelectedLabel();
      requestRender();
    },
    onPick(callback) {
      picked = callback;
    },
    resize,
    dispose() {
      disposed = true;
      cancelAnimationFrame(handle);
      handle = 0;
      observer?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("click", onClick);
      clearRecords();
      faces.clear();
      discGeometry.dispose();
      particles.geometry.dispose();
      particles.material.dispose();
      halo.material.map.dispose();
      halo.material.dispose();
      renderer.dispose();
      labelLayer.remove();
      canvas.remove();
    },
  };
}
