// @ts-check
/**
 * Song cache: a song downloaded once stays in the visitor's own browser.
 *
 * The MPB songs live at a site that sends no CORS header, so the page cannot fetch their MIDI
 * files: the visitor downloads one and opens it in the page by hand. That is a lot of work to
 * repeat for a song heard before, so the page keeps the file in the browser's IndexedDB, on this
 * device only. Nothing is uploaded and nothing is published; "Forget downloaded songs" empties
 * the store.
 *
 * Only the file the catalog describes is kept. Every MPB record carries the SHA-256 of its MIDI
 * file (`facts.sha256`, measured when the catalog was built), so a file the visitor opens for a
 * record is stored when its hash is the record's, and not when it is something else (another
 * version, a wrong file, a damaged download). The same check runs when the bytes are read back,
 * so a damaged store never reaches the reader.
 *
 * The store is a small interface (`get`, `put`, `keys`, `clear`), so the rules above are tested
 * in Node with a fake. `indexedDbStore` is the real one. Every call to the store is guarded:
 * private windows and blocked site data make IndexedDB fail, and the page then simply has no
 * cache and keeps its download-and-open flow.
 */

/**
 * @typedef {object} SongStore a key-value store of downloaded files
 * @property {(key: string) => Promise<{bytes: Uint8Array, sha256?: string} | null>} get
 * @property {(key: string, value: {bytes: Uint8Array, savedAt: number, sha256?: string}) => Promise<void>} put
 * @property {() => Promise<string[]>} keys
 * @property {() => Promise<void>} clear
 */

/** @typedef {{id: string, source?: string, facts?: {sha256?: string}}} CachedRecord */

/**
 * What `remember` reports:
 * - "stored": the file is the record's and is now in the cache;
 * - "mismatch": the file is not the one the record describes, so it is not kept;
 * - "unchecked": the record names no SHA-256, so there is nothing to check the file against;
 * - "unavailable": the browser has no store or refused to write.
 *
 * @typedef {"stored" | "mismatch" | "unchecked" | "unavailable"} RememberResult
 */

const DATABASE = "nes-arranger";
const STORE = "songs";

/**
 * The key a song is stored under: its source and id, as everywhere else in the page.
 *
 * @param {{id: string, source?: string}} entry
 * @returns {string}
 * @example
 * cacheKey({ id: "agua-de-lua", source: "mpb" }); // "mpb:agua-de-lua"
 */
export function cacheKey(entry) {
  return `${entry.source}:${entry.id}`;
}

/**
 * The SHA-256 of some bytes, as 64 hex digits (the form the catalog records use).
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
export async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Whether a file with this hash is the file a record describes.
 *
 * @param {CachedRecord} entry
 * @param {string} sha256 the file's SHA-256 in hex
 * @returns {boolean} false for a record that names no hash
 * @example
 * fileMatchesEntry({ id: "a", facts: { sha256: "AB12" } }, "ab12"); // true
 */
export function fileMatchesEntry(entry, sha256) {
  const wanted = entry.facts?.sha256;
  return typeof wanted === "string" && wanted !== "" && wanted.toLowerCase() === sha256.toLowerCase();
}

/**
 * Songs found by an online search have no recorded hash (the catalog never measured their file).
 * For those the page may ask to trust the first download (`trustFirstDownload`): the hash of the
 * bytes is kept next to them, and later reads are checked against it, so a damaged store is still
 * caught, though a wrong first download is not.
 *
 * A cache of downloaded songs over a store.
 *
 * `has` is what the shelf and the playlists ask (`isCached(entry)`), so it is synchronous and
 * answers from a set of keys that `load` reads once and `remember` and `forget` keep up to date.
 *
 * @param {SongStore | null} store null when the browser has none: the cache is then always empty
 * @returns {{
 *   load: () => Promise<void>,
 *   has: (entry: {id: string, source?: string}) => boolean,
 *   keys: () => string[],
 *   readonly size: number,
 *   remember: (entry: CachedRecord, bytes: Uint8Array, sha256?: string, options?: {trustFirstDownload?: boolean}) => Promise<RememberResult>,
 *   bytesOf: (entry: CachedRecord) => Promise<Uint8Array | null>,
 *   forget: () => Promise<void>,
 * }}
 * @example
 * const cache = createSongCache(indexedDbStore());
 * await cache.load();
 * await cache.remember(entry, bytes); // "stored" when the bytes are the file the record names
 * cache.has(entry); // true
 */
export function createSongCache(store) {
  /** @type {Set<string>} */
  const known = new Set();

  /** @param {{id: string, source?: string}} entry */
  const has = (entry) => known.has(cacheKey(entry));

  return {
    async load() {
      try {
        for (const key of (await store?.keys()) ?? []) known.add(key);
      } catch {
        // No readable store: the cache stays empty.
      }
    },
    has,
    keys: () => [...known],
    get size() {
      return known.size;
    },
    async remember(entry, bytes, sha256, { trustFirstDownload = false } = {}) {
      if (!store) return "unavailable";
      const hash = sha256 ?? (await sha256Hex(bytes));
      const recorded = Boolean(entry.facts?.sha256);
      if (!recorded && !trustFirstDownload) return "unchecked";
      if (recorded && !fileMatchesEntry(entry, hash)) return "mismatch";
      if (has(entry)) return "stored";
      try {
        await store.put(cacheKey(entry), { bytes, savedAt: Date.now(), sha256: hash });
      } catch {
        return "unavailable";
      }
      known.add(cacheKey(entry));
      return "stored";
    },
    async bytesOf(entry) {
      if (!store || !has(entry)) return null;
      try {
        const saved = await store.get(cacheKey(entry));
        if (saved) {
          // A record that names a hash is the judge; one that does not is judged by the hash
          // kept with the file when it was first stored.
          const expected = entry.facts?.sha256 ?? saved.sha256;
          const hash = await sha256Hex(saved.bytes);
          if (typeof expected === "string" && expected.toLowerCase() === hash.toLowerCase()) return saved.bytes;
        }
      } catch {
        // An unreadable store is the same as an empty one.
      }
      // Missing, damaged, or from an older catalog: the song asks for a download again.
      known.delete(cacheKey(entry));
      return null;
    },
    async forget() {
      known.clear();
      try {
        await store?.clear();
      } catch {
        // Nothing more can be done; the page already behaves as if the cache were empty.
      }
    },
  };
}

/**
 * Wrap an IDBRequest in a promise.
 *
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
function asPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * The real store, in IndexedDB. The database opens at the first call, not when the page loads.
 *
 * @param {IDBFactory | undefined} [factory] default: the page's `indexedDB`
 * @returns {SongStore | null} null when the browser has no IndexedDB
 */
export function indexedDbStore(factory = globalThis.indexedDB) {
  if (!factory) return null;
  /** @type {Promise<IDBDatabase> | null} */
  let opening = null;
  const open = () => {
    opening ??= new Promise((resolve, reject) => {
      const request = factory.open(DATABASE, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("the song store is blocked"));
    });
    opening.catch(() => (opening = null)); // a failed open is tried again next time
    return opening;
  };
  /** @param {IDBTransactionMode} mode */
  const objects = async (mode) => (await open()).transaction(STORE, mode).objectStore(STORE);
  return {
    get: async (key) => (await asPromise((await objects("readonly")).get(key))) ?? null,
    put: async (key, value) => void (await asPromise((await objects("readwrite")).put(value, key))),
    keys: async () => (await asPromise((await objects("readonly")).getAllKeys())).map(String),
    clear: async () => void (await asPromise((await objects("readwrite")).clear())),
  };
}

/**
 * The page's store, or null when the browser has none or refuses to say (reading `indexedDB`
 * throws in some browsers when site data is blocked).
 *
 * @returns {SongStore | null}
 */
export function browserSongStore() {
  try {
    return indexedDbStore();
  } catch {
    return null;
  }
}
