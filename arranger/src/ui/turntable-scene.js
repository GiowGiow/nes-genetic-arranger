// @ts-check
/**
 * Turntable scene: the Result's record player in three.js, in the shelf's low-poly, chunky style.
 *
 * Everything is a few flat-shaded primitives: a plinth, a platter with a ring of strobe dots, a
 * spindle, the tonearm (pivot, tube, headshell, counterweight) and a lamp. The record is the
 * shelf's own mesh: the same 28-sided cylinder with the same 128×128 face texture
 * (`record-art.js`), sampled with nearest-neighbour filtering and rendered at about half the
 * device's pixels, so the pixel art stays blocky. The lights are the shelf's too: a soft ambient,
 * a white key light and rim lights in the P1 blue and the P2 orange.
 *
 * The scene holds no state of its own beyond what is on the screen: the view
 * (`turntable-view.js`) says every frame how far the record has turned, where the arm points and
 * how high the needle is raised, and the scene only moves the meshes and renders. Like the shelf's
 * scene it is the only place that imports three.js for this view, and it throws when the browser
 * has no WebGL 2, which sends the view back to its 2D picture.
 */

// @ts-ignore: "three" resolves through the page's import map (vendor/three/), not on disk.
import * as THREE from "three";

import { ARM_LENGTH, ARM_PIVOT, CAMERA_FOV, cameraDistance } from "./turntable-geometry.js";

/** The height of the record's surface above the plane the geometry works in. */
const RECORD_TOP = 0.13;
const ARM_HEIGHT = 0.24;
/** How high the camera looks down from, in radians: 46 degrees above the platter's plane. */
const ELEVATION = 0.8;

/**
 * A canvas texture shown pixel for pixel.
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

/** The platter's top: dark metal with a ring of strobe dots, as on a real direct-drive deck. @returns {any} */
function platterTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  context.fillStyle = "#262d40";
  context.fillRect(0, 0, 128, 128);
  context.fillStyle = "rgba(207, 207, 207, .55)";
  for (let dot = 0; dot < 48; dot += 1) {
    const angle = (dot / 48) * Math.PI * 2;
    context.fillRect(Math.round(64 + Math.cos(angle) * 61) - 1, Math.round(64 + Math.sin(angle) * 61) - 1, 2, 2);
  }
  return pixelTexture(canvas);
}

/**
 * Build the scene inside `host` and return a renderer for the view.
 *
 * @param {HTMLElement} host the turntable's stage; the canvas is added to it
 * @returns {import("./turntable-view.js").TurntableRenderer}
 * @throws {Error} when the browser cannot create a WebGL 2 context (the view then keeps its 2D picture)
 * @example
 * const scene = createTurntableScene(stage);
 * scene.resize(480, 400, 1);
 * scene.draw({ spinAngle: 0, armAngle: 2, lift: 0, playing: false, time: 0 });
 */
export function createTurntableScene(host) {
  const canvas = document.createElement("canvas");
  canvas.className = "turntable-canvas is-entering";
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

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 50);
  const target = new THREE.Vector3(0.28, 0, -0.08);
  camera.position.set(0.28, 3.7, 3.6);
  camera.lookAt(target);
  scene.add(new THREE.AmbientLight(0x8090b0, 0.6));
  for (const [color, intensity, [x, y, z]] of /** @type {Array<[number, number, [number, number, number]]>} */ ([
    [0xffffff, 1.3, [2, 5, 4]],
    [0x5f9ed1, 0.9, [-6, 2, 1]],
    [0xff800e, 0.7, [6, 1, 2]],
  ])) {
    const light = new THREE.DirectionalLight(color, intensity);
    light.position.set(x, y, z);
    scene.add(light);
  }

  /** @type {any[]} things to dispose: geometries, materials and textures */
  const owned = [];
  /** @template T @param {T} thing @returns {T} */
  const own = (thing) => {
    owned.push(thing);
    return thing;
  };
  const flat = (/** @type {number} */ color, shininess = 20) =>
    own(new THREE.MeshPhongMaterial({ color, shininess, flatShading: true }));

  // Plinth: a base and a slightly smaller, lighter top plate, so it has an edge.
  const base = new THREE.Mesh(own(new THREE.BoxGeometry(3.2, 0.3, 2.75)), flat(0x1d2438));
  base.position.set(0.3, -0.18, -0.08);
  const plate = new THREE.Mesh(own(new THREE.BoxGeometry(3.08, 0.04, 2.63)), flat(0x2a3552, 50));
  plate.position.set(0.3, -0.01, -0.08);
  scene.add(base, plate);
  for (const [x, z] of [[-1.15, -1.3], [1.75, -1.3], [-1.15, 1.15], [1.75, 1.15]]) {
    const foot = new THREE.Mesh(own(new THREE.CylinderGeometry(0.1, 0.12, 0.1, 6)), flat(0x07080c));
    foot.position.set(x, -0.38, z);
    scene.add(foot);
  }

  // Platter and record turn together.
  const spinning = new THREE.Group();
  const platterTop = own(platterTexture());
  const platter = new THREE.Mesh(own(new THREE.CylinderGeometry(1.1, 1.1, 0.1, 32)), [
    flat(0x2b3350, 60),
    own(new THREE.MeshPhongMaterial({ map: platterTop, shininess: 40 })),
    flat(0x1a2030),
  ]);
  platter.position.y = 0.05;
  const edgeMaterial = flat(0x07080c);
  const faceMaterial = own(new THREE.MeshPhongMaterial({ color: 0x0b0d14, shininess: 25, specular: 0x111622 }));
  const record = new THREE.Mesh(own(new THREE.CylinderGeometry(1, 1, 0.035, 28)), [edgeMaterial, faceMaterial, faceMaterial]);
  record.position.y = RECORD_TOP - 0.0175;
  spinning.add(platter, record);
  scene.add(spinning);
  const spindle = new THREE.Mesh(own(new THREE.CylinderGeometry(0.03, 0.03, 0.16, 8)), flat(0xcfcfcf, 80));
  spindle.position.y = RECORD_TOP + 0.04;
  scene.add(spindle);

  // The lamp that is lit while the motor runs, in the P2 orange.
  const lampMaterial = own(new THREE.MeshBasicMaterial({ color: 0x3a3f50 }));
  const lamp = new THREE.Mesh(own(new THREE.BoxGeometry(0.1, 0.05, 0.1)), lampMaterial);
  lamp.position.set(1.6, 0.03, 1.0);
  scene.add(lamp);

  // Tonearm: turns about the pivot (yaw), and the whole arm tilts to lift the needle.
  const pivot = new THREE.Group();
  pivot.position.set(ARM_PIVOT.x, 0, ARM_PIVOT.z);
  const tower = new THREE.Mesh(own(new THREE.CylinderGeometry(0.17, 0.2, ARM_HEIGHT, 10)), flat(0x2a3042, 60));
  tower.position.y = ARM_HEIGHT / 2;
  const cap = new THREE.Mesh(own(new THREE.CylinderGeometry(0.1, 0.1, 0.05, 10)), flat(0x5f9ed1, 70));
  cap.position.y = ARM_HEIGHT + 0.02;
  pivot.add(tower, cap);
  const yaw = new THREE.Group();
  yaw.position.y = ARM_HEIGHT;
  const tilt = new THREE.Group();
  const tube = new THREE.Mesh(own(new THREE.CylinderGeometry(0.03, 0.03, ARM_LENGTH, 8)), flat(0xcfcfcf, 90));
  tube.rotation.z = Math.PI / 2;
  tube.position.x = ARM_LENGTH / 2;
  const headshell = new THREE.Mesh(own(new THREE.BoxGeometry(0.24, 0.05, 0.13)), flat(0xffbc79, 40));
  headshell.position.set(ARM_LENGTH + 0.02, -0.01, 0);
  const stylus = new THREE.Mesh(own(new THREE.BoxGeometry(0.02, 0.1, 0.02)), flat(0xe6e9f0, 90));
  stylus.position.set(ARM_LENGTH + 0.1, -0.07, 0);
  const counterweight = new THREE.Mesh(own(new THREE.CylinderGeometry(0.09, 0.09, 0.26, 10)), flat(0x8d94a8, 70));
  counterweight.rotation.z = Math.PI / 2;
  counterweight.position.x = -0.3;
  tilt.add(tube, headshell, stylus, counterweight);
  yaw.add(tilt);
  pivot.add(yaw);
  scene.add(pivot);

  /** The record's face texture, replaced when the song changes. @type {any} */
  let faceTexture = null;
  const raycaster = new THREE.Raycaster();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -RECORD_TOP);
  const hit = new THREE.Vector3();
  const pointer = new THREE.Vector2();

  return {
    canvas,
    resize(width, height, pixelRatio) {
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      // A narrow stage moves the camera back so the whole plinth stays in view (45 degrees above it).
      const distance = cameraDistance(camera.aspect);
      camera.position.set(target.x, target.y + distance * Math.sin(ELEVATION), target.z + distance * Math.cos(ELEVATION));
      camera.lookAt(target);
      camera.updateProjectionMatrix();
    },
    setRecord(face) {
      faceTexture?.dispose();
      faceTexture = null;
      if (face) {
        faceTexture = pixelTexture(face);
        faceMaterial.map = faceTexture;
        faceMaterial.color.set(0xffffff);
      } else {
        faceMaterial.map = null;
        faceMaterial.color.set(0x0b0d14);
      }
      faceMaterial.needsUpdate = true;
    },
    draw({ spinAngle, armAngle, lift, playing }) {
      // Clockwise seen from above is a negative turn about +y.
      spinning.rotation.y = -spinAngle;
      yaw.rotation.y = -armAngle;
      tilt.rotation.z = lift * 0.16;
      lampMaterial.color.set(playing ? 0xff800e : 0x3a3f50);
      renderer.render(scene, camera);
    },
    planePoint(clientX, clientY) {
      const box = canvas.getBoundingClientRect();
      if (!box.width || !box.height) return null;
      pointer.set(((clientX - box.left) / box.width) * 2 - 1, -((clientY - box.top) / box.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      return raycaster.ray.intersectPlane(plane, hit) ? { x: hit.x, z: hit.z } : null;
    },
    dispose() {
      faceTexture?.dispose();
      for (const thing of owned) thing.dispose?.();
      renderer.dispose();
      canvas.remove();
    },
  };
}
