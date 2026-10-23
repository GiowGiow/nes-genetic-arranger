// @ts-check
// Tests for core/song-cache.js: a downloaded song is remembered in the visitor's own browser, so
// it needs downloading only once. Node has no IndexedDB, so a fake store (a Map behind async
// calls) stands in for it; the real store is checked in the browser.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { cacheKey, createSongCache, fileMatchesEntry, sha256Hex } from "../src/core/song-cache.js";

/** A synthetic file; never a copy of a catalog file. @param {number} seed */
const midiBytes = (seed) => new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, 1, 0, 96, seed]);
/** @param {Uint8Array} bytes */
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A catalog record whose recorded hash is that of `bytes`. @param {string} id @param {Uint8Array} bytes */
const record = (id, bytes) => ({
  id,
  source: "mpb",
  t: id.toUpperCase(),
  route: { download: `https://example.org/${id}.mid` },
  facts: { sha256: sha(bytes), melody_track: 1, bars: [0, 8], overrides: { max_generations: 4000 } },
});

/** A store that keeps records in a map. */
function fakeStore() {
  /** @type {Map<string, any>} */
  const items = new Map();
  return {
    items,
    get: async (/** @type {string} */ key) => items.get(key) ?? null,
    put: async (/** @type {string} */ key, /** @type {any} */ value) => void items.set(key, value),
    keys: async () => [...items.keys()],
    clear: async () => items.clear(),
  };
}

/** A store whose every call fails, as IndexedDB does in some private windows. */
function brokenStore() {
  const fail = async () => {
    throw new Error("the browser refused storage");
  };
  return { get: fail, put: fail, keys: fail, clear: fail };
}

test("a song is kept under its source and id", () => {
  assert.equal(cacheKey({ id: "agua-de-lua", source: "mpb" }), "mpb:agua-de-lua");
});

test("a file belongs to a record when its SHA-256 is the one the record names, in any letter case", () => {
  const bytes = midiBytes(1);
  assert.equal(fileMatchesEntry(record("a", bytes), sha(bytes)), true);
  assert.equal(fileMatchesEntry(record("a", bytes), sha(bytes).toUpperCase()), true);
  assert.equal(fileMatchesEntry(record("a", bytes), sha(midiBytes(2))), false);
  assert.equal(fileMatchesEntry({ id: "b", source: "mpb", t: "B" }, sha(bytes)), false, "a record with no hash cannot vouch for a file");
});

test("the hash is the standard SHA-256 in hex", async () => {
  assert.equal(await sha256Hex(midiBytes(7)), sha(midiBytes(7)));
});

test("a file that matches its record is stored, and the cache then knows the song", async () => {
  const store = fakeStore();
  const cache = createSongCache(store);
  const bytes = midiBytes(1);
  const entry = record("a", bytes);
  assert.equal(cache.has(entry), false);
  assert.equal(await cache.remember(entry, bytes), "stored");
  assert.equal(cache.has(entry), true);
  assert.deepEqual([...store.items.keys()], ["mpb:a"]);
  assert.deepEqual(cache.keys(), ["mpb:a"]);
  assert.deepEqual(await cache.bytesOf(entry), bytes);
});

test("a hash computed already can be passed in, to save hashing the file again", async () => {
  const cache = createSongCache(fakeStore());
  const bytes = midiBytes(1);
  assert.equal(await cache.remember(record("a", bytes), bytes, sha(bytes)), "stored");
});

test("a file that does not match its record is not stored", async () => {
  const store = fakeStore();
  const cache = createSongCache(store);
  const entry = record("a", midiBytes(1));
  assert.equal(await cache.remember(entry, midiBytes(2)), "mismatch");
  assert.equal(cache.has(entry), false);
  assert.equal(store.items.size, 0);
});

test("a record with no SHA-256 cannot be checked, so nothing is stored", async () => {
  const store = fakeStore();
  const cache = createSongCache(store);
  const entry = { id: "a", source: "mpb", t: "A", route: { download: "https://example.org/a.mid" } };
  assert.equal(await cache.remember(entry, midiBytes(1)), "unchecked");
  assert.equal(cache.has(entry), false);
  assert.equal(store.items.size, 0);
});

test("a song that is already stored is not written again", async () => {
  const store = fakeStore();
  const cache = createSongCache(store);
  const bytes = midiBytes(1);
  const entry = record("a", bytes);
  await cache.remember(entry, bytes);
  let writes = 0;
  const put = store.put;
  store.put = async (key, value) => {
    writes++;
    return put(key, value);
  };
  assert.equal(await cache.remember(entry, bytes), "stored");
  assert.equal(writes, 0);
});

test("a cache loaded on a later visit knows the songs stored before", async () => {
  const store = fakeStore();
  const bytes = midiBytes(1);
  await createSongCache(store).remember(record("a", bytes), bytes);
  const later = createSongCache(store);
  assert.equal(later.has(record("a", bytes)), false, "nothing is known before load");
  await later.load();
  assert.equal(later.has(record("a", bytes)), true);
  assert.equal(later.has(record("b", bytes)), false);
  assert.equal(later.size, 1);
});

test("bytesOf answers null for a song that was never stored", async () => {
  const cache = createSongCache(fakeStore());
  assert.equal(await cache.bytesOf(record("a", midiBytes(1))), null);
});

test("bytes that no longer match the record (a damaged store) are not handed out, and the song is forgotten", async () => {
  const store = fakeStore();
  const cache = createSongCache(store);
  const bytes = midiBytes(1);
  const entry = record("a", bytes);
  await cache.remember(entry, bytes);
  store.items.set("mpb:a", { ...store.items.get("mpb:a"), bytes: midiBytes(9) });
  assert.equal(await cache.bytesOf(entry), null);
  assert.equal(cache.has(entry), false, "so the song offers the download again");
});

test("a record whose hash changed in a newer catalog is downloaded again", async () => {
  const cache = createSongCache(fakeStore());
  const bytes = midiBytes(1);
  await cache.remember(record("a", bytes), bytes);
  const newer = record("a", midiBytes(2));
  assert.equal(await cache.bytesOf(newer), null);
  assert.equal(cache.has(newer), false);
});

test("forget empties the store and the cache", async () => {
  const store = fakeStore();
  const cache = createSongCache(store);
  const bytes = midiBytes(1);
  await cache.remember(record("a", bytes), bytes);
  await cache.forget();
  assert.equal(cache.size, 0);
  assert.equal(cache.has(record("a", bytes)), false);
  assert.equal(store.items.size, 0);
});

test("without a store (no IndexedDB) the cache is empty and quiet", async () => {
  const cache = createSongCache(null);
  const bytes = midiBytes(1);
  await cache.load();
  assert.equal(await cache.remember(record("a", bytes), bytes), "unavailable");
  assert.equal(cache.has(record("a", bytes)), false);
  assert.equal(await cache.bytesOf(record("a", bytes)), null);
  await cache.forget();
  assert.equal(cache.size, 0);
});

test("a store that refuses every call degrades to no cache, without throwing", async () => {
  const cache = createSongCache(brokenStore());
  const bytes = midiBytes(1);
  const entry = record("a", bytes);
  await cache.load();
  assert.equal(await cache.remember(entry, bytes), "unavailable");
  assert.equal(cache.has(entry), false, "a song that could not be stored is not claimed as stored");
  assert.equal(await cache.bytesOf(entry), null);
  await cache.forget();
});

test("the predicate for the shelf is a plain function of a record", async () => {
  const cache = createSongCache(fakeStore());
  const bytes = midiBytes(1);
  await cache.remember(record("a", bytes), bytes);
  const isCached = cache.has;
  assert.equal(isCached(record("a", bytes)), true, "usable detached from the cache object");
});
