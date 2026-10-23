// @ts-check
/**
 * Texture cache: the shelf's memory of what a record's face looks like.
 *
 * Drawing a record's face (grooves, label, the song's sprite) costs about 8 ms on a desktop and
 * five times that on a phone, and a page has up to 27 records, so turning a page used to freeze
 * the scene for 130 ms or more. The faces depend only on the song, so they are kept: turning
 * back to a page just drawn finds its faces ready, and the page the visitor is likely to turn to
 * next can be drawn in advance while the browser is idle.
 *
 * It is a least-recently-used cache: when it holds more than its limit the face used longest ago
 * is let go (and released, so a GPU texture is freed). Faces that are held because they are on
 * screen are never let go, and do not count toward the limit. The cache knows nothing about three.js: it is given how to make and release a
 * face, so the tests run on plain objects.
 */

/**
 * @template T
 * @typedef {object} TextureCache
 * @property {(key: string, context?: any) => T} get the face for a key, made (with `context`, for
 *   instance the song it is the face of) if it was not here; marks it fresh
 * @property {(key: string) => boolean} has
 * @property {(face: T) => void} hold keep a face while it is on screen
 * @property {(face: T) => void} unhold
 * @property {() => void} clear let every face go
 * @property {number} size
 */

/**
 * @template T
 * @param {{limit: number, make: (key: string, context?: any) => T, release?: (face: T) => void}} parts
 *   `limit`: how many faces to keep (two pages of a wide shelf is 54)
 * @returns {TextureCache<T>}
 * @example
 * const faces = createTextureCache({ limit: 60, make: (key) => drawFace(key), release: (face) => face.dispose() });
 * faces.get("mpb:aquarela"); // drawn
 * faces.get("mpb:aquarela"); // remembered
 */
export function createTextureCache({ limit, make, release = () => {} }) {
  /** @type {Map<string, T>} insertion order is use order: the first key is the least recent */
  const faces = new Map();
  /** @type {Map<T, number>} faces on screen, with how many users hold them */
  const held = new Map();

  // The limit counts the faces nobody holds: a held face is on screen and must stay, and it
  // should not push the freshly made ones out.
  function trim() {
    let loose = faces.size - [...faces.values()].filter((face) => held.has(face)).length;
    for (const [key, face] of faces) {
      if (loose <= limit) return;
      if (held.has(face)) continue;
      faces.delete(key);
      release(face);
      loose -= 1;
    }
  }

  return {
    get(key, context) {
      let face = faces.get(key);
      if (face === undefined) {
        face = make(key, context);
      } else {
        faces.delete(key); // re-insert at the end: now the freshest
      }
      faces.set(key, face);
      trim();
      return face;
    },
    has: (key) => faces.has(key),
    hold(face) {
      held.set(face, (held.get(face) ?? 0) + 1);
    },
    unhold(face) {
      const count = (held.get(face) ?? 1) - 1;
      if (count <= 0) held.delete(face);
      else held.set(face, count);
      trim();
    },
    clear() {
      for (const face of faces.values()) release(face);
      faces.clear();
      held.clear();
    },
    get size() {
      return faces.size;
    },
  };
}
