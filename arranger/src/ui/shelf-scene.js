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
 * - **Titles.** Under each record hangs a strip with the song's title in light pixel letters
 *   with a soft glow (a canvas texture). A title wider than the strip scrolls like a marquee:
 *   the texture holds the title, a gap and then the room to repeat, and only its offset moves
 *   (`RepeatWrapping`). A short title stays still and centred. The selected record's strip is
 *   brighter. Under reduced motion nothing scrolls: a long title is cut with an ellipsis.
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
  HALO_SCALE,
  MARQUEE_STAGGER,
  STRIP_HEIGHT,
  STRIP_PADDING,
  STRIP_PIXELS,
  STRIP_WIDTH,
  cameraDistance,
  ellipsize,
  haloOpacity,
  isLowPower,
  marqueeCycle,
  marqueeOffset,
  pixelRatioFor,
  recordPose,
  scaleEasing,
  shelfColumns,
  shouldRenderFrame,
  stripOpacity,
  stripY,
  targetFps,
  titleNeedsScroll,
} from "./shelf-layout.js";
import { CHANNEL_COLORS, drawSprite, entrySprite } from "./sprites.js";

/** Faint particles drifting behind the records. */
const PARTICLE_COUNT = 90;
const PARTICLE_SEED = 5;

/** Size of a record's face texture, in pixels, and of the sprite on its label (3 px a cell). */
const TEXTURE_SIZE = 128;
const SPRITE_SCALE = 3;

/** The title strips' letters: a bold monospace face, drawn small so each stroke is a few pixels. */
const STRIP_FONT = '700 11px ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';
const STRIP_TEXT = "#e6f0ff";
const STRIP_GLOW = "rgba(140, 190, 240, 0.95)";
const STRIP_BACKDROP = "rgba(8, 10, 20, 0.6)";

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
 * The texture of a title strip and what the scene needs to scroll it.
 *
 * A title that fits is drawn centred on a texture the size of the strip. One that does not is,
 * with motion, drawn at the left of a wider texture, followed by a gap, and the strip shows a
 * window of it that moves (`cycle` pixels make one pass); under reduced motion it is cut with
 * an ellipsis instead and does not move.
 *
 * @param {string} title the title to show
 * @param {CanvasRenderingContext2D} measuring a context whose font is `STRIP_FONT`
 * @param {boolean} reducedMotion
 * @returns {{texture: any, cycle: number, width: number}} `cycle` is 0 for a title that stays
 *   still; `width` is the texture's width in pixels
 */
function titleTexture(title, measuring, reducedMotion) {
  const measure = (/** @type {string} */ text) => measuring.measureText(text).width;
  const fullWidth = Math.ceil(measure(title));
  const scrolls = titleNeedsScroll(fullWidth) && !reducedMotion;
  const shown = titleNeedsScroll(fullWidth) && reducedMotion ? ellipsize(title, STRIP_PIXELS.width - 2 * STRIP_PADDING, measure) : title;
  const cycle = scrolls ? marqueeCycle(fullWidth) : 0;
  const canvas = document.createElement("canvas");
  canvas.width = scrolls ? cycle : STRIP_PIXELS.width;
  canvas.height = STRIP_PIXELS.height;
  const context = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  context.fillStyle = STRIP_BACKDROP;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = STRIP_FONT;
  context.textBaseline = "middle";
  context.textAlign = scrolls ? "left" : "center";
  context.fillStyle = STRIP_TEXT;
  context.shadowColor = STRIP_GLOW;
  context.shadowBlur = 4;
  const x = scrolls ? STRIP_PADDING : canvas.width / 2;
  const y = canvas.height / 2 + 1;
  context.fillText(shown, x, y);
  context.shadowBlur = 0;
  context.fillText(shown, x, y); // a second, sharp pass on top of the glow
  const texture = pixelTexture(canvas);
  // Magnified, the letters stay blocky; shrunk below their size (a phone), linear keeps thin strokes whole
  texture.minFilter = THREE.LinearFilter;
  if (scrolls) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.repeat.x = STRIP_PIXELS.width / canvas.width;
  }
  return { texture, cycle, width: canvas.width };
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
export function createShelfScene(host, { reducedMotion }) {
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
  const strips = new THREE.Group();
  scene.add(particles, halo, records, strips);

  const stripGeometry = new THREE.PlaneGeometry(STRIP_WIDTH, STRIP_HEIGHT);
  const measuring = /** @type {CanvasRenderingContext2D} */ (document.createElement("canvas").getContext("2d"));
  measuring.font = STRIP_FONT;

  const discGeometry = new THREE.CylinderGeometry(1, 1, 0.05, 28);
  const edgeMaterial = new THREE.MeshPhongMaterial({ color: 0x07080c, shininess: 20 });

  let selected = 0;
  /** Seconds (animation clock) when the selected record was selected: its title starts over then. */
  let selectedAt = performance.now() / 1000;
  let columns = 5;
  /** @type {((index: number) => void) | null} */
  let picked = null;

  function clearRecords() {
    for (const group of [...records.children]) {
      const face = group.children[0].material[1];
      face.map.dispose();
      face.dispose();
      records.remove(group);
    }
    for (const strip of [...strips.children]) {
      strip.material.map.dispose();
      strip.material.dispose();
      strips.remove(strip);
    }
  }

  /** @param {CatalogEntry} entry @param {number} index */
  function makeStrip(entry, index) {
    const { texture, cycle, width } = titleTexture(displayTitle(entry.t), measuring, reducedMotion);
    // Drawn over everything (no depth test): the selected record comes forward and grows, and
    // must not hide the title of its neighbour above it
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
    const strip = new THREE.Mesh(stripGeometry, material);
    strip.renderOrder = 2;
    strip.userData = { index, cycle, width };
    return strip;
  }

  /** @param {CatalogEntry} entry @param {number} index */
  function makeRecord(entry, index) {
    const face = new THREE.MeshPhongMaterial({ map: recordTexture(entry), shininess: 25, specular: 0x111622 });
    // A cylinder's materials are [side, top, bottom]: both faces show the label.
    const disc = new THREE.Mesh(discGeometry, [edgeMaterial, face, face]);
    disc.rotation.x = Math.PI / 2;
    const group = new THREE.Group();
    group.add(disc);
    group.userData.index = index;
    group.scale.setScalar(0.62);
    return group;
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
    camera.aspect = width / height;
    camera.position.set(0, 0, cameraDistance(columns, camera.aspect));
    camera.updateProjectionMatrix();
    requestRender();
  }

  /**
   * Put the records, their strips and the glow where they belong at a moment, and draw.
   *
   * @param {number} timestamp milliseconds, from `requestAnimationFrame`
   * @param {number} elapsed milliseconds since the last drawn frame
   */
  function draw(timestamp, elapsed) {
    const time = timestamp / 1000;
    const ease = scaleEasing(elapsed);
    records.children.forEach((/** @type {any} */ group, /** @type {number} */ index) => {
      const pose = recordPose(index, { selected: index === selected, columns, time, reducedMotion });
      group.position.set(pose.x, pose.y, pose.z);
      group.rotation.y = pose.tilt;
      if (pose.spin !== null) group.children[0].rotation.y = pose.spin;
      const scale = reducedMotion ? pose.scale : THREE.MathUtils.lerp(group.scale.x, pose.scale, ease);
      group.scale.setScalar(scale);
      const strip = strips.children[index];
      if (strip) {
        strip.position.set(pose.x, stripY(pose.y, scale), pose.z);
        strip.material.opacity = stripOpacity(index === selected);
        const { cycle, width } = strip.userData;
        if (cycle) {
          const clock = index === selected ? time - selectedAt : time + index * MARQUEE_STAGGER;
          strip.material.map.offset.x = marqueeOffset(clock, cycle) / width;
        }
      }
    });
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
    const hit = raycaster.intersectObjects([...records.children, ...strips.children], true)[0];
    if (!hit) return;
    let object = hit.object;
    while (object.parent !== records && object.parent !== strips) object = object.parent;
    picked?.(object.userData.index);
  }
  canvas.addEventListener("click", onClick);

  requestRender();

  return {
    setPage(entries, selectedIndex, pageColumns) {
      clearRecords();
      entries.forEach((entry, index) => {
        records.add(makeRecord(entry, index));
        strips.add(makeStrip(entry, index));
      });
      selected = selectedIndex;
      selectedAt = performance.now() / 1000;
      columns = pageColumns ?? shelfColumns(host.clientWidth);
      resize();
      requestRender();
    },
    select(index) {
      if (index !== selected) selectedAt = performance.now() / 1000;
      selected = index;
      requestRender();
    },
    onPick(callback) {
      picked = callback;
    },
    resize,
    dispose() {
      cancelAnimationFrame(handle);
      handle = 0;
      observer?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("click", onClick);
      clearRecords();
      stripGeometry.dispose();
      discGeometry.dispose();
      edgeMaterial.dispose();
      particles.geometry.dispose();
      particles.material.dispose();
      halo.material.map.dispose();
      halo.material.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
}
