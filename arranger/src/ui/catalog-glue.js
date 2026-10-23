// @ts-check
// The glue between the song shelf and the rest of the page.
//
// The shelf shows records: the catalog's songs, the visitor's own files and, while they search,
// the tunes of The Session. This module reads the catalog, answers what the visitor does with a
// record, and keeps the songs they download:
//
// - Loading: the small catalog files first, so the shelf has songs at once; the large ones (MPB's
//   is 2 MB) in the background once the browser is idle (not on a metered or slow connection),
//   and at once when the visitor opens their playlist or searches, with the share that has
//   arrived shown on the shelf. The songs kept from an earlier visit (`core/song-cache.js`)
//   join Catalog.
// - Arrange and Preview on a record: its file is read through the input panel, as if it had been
//   dropped, and then the run starts (Arrange) or the intro plays (Preview). A song that is
//   already loaded is not read again, because a fresh reading would throw away the melody track
//   the visitor chose.
// - Songs on other sites (MPB, BitMidi, midis101.com, the Mutopia Project) open in one click: the
//   MIDI fetcher Worker (`core/midi-fetcher.js`) brings the file, and the browser keeps it. If
//   the Worker fails, the song falls back to the older flow and a toast says why: "Download
//   MIDI" lets the browser save the file, and "Open downloaded file" asks the visitor to choose
//   it, which the page then reads and keeps for next time.
// - Search: after the visitor pauses typing, the online sources (`core/online-search.js`) are
//   asked, each once, and their results are added after the catalog's matches, with the state of
//   the search (who is still being asked, who failed) for the shelf to show.
//
// Every message to the visitor goes through `songStatus`: the status line in the Song card and a
// toast, because that line sits far below the shelf on a phone.
//
// Everything the module touches comes in as a parameter, so the tests run it on fakes.

import {
  COOL_DOWN_MS,
  createFetcherHealth,
  failureMessage,
  fetchMidiFile,
  isFetchable,
} from "../core/midi-fetcher.js";
import { DEBOUNCE_MS, MIN_QUERY_LENGTH, createOnlineSearch } from "../core/online-search.js";
import { createOnlineSources } from "../core/online-sources.js";
import { browserSongStore, createSongCache, cacheKey } from "../core/song-cache.js";
import {
  FALLBACK_COLLECTIONS,
  MIDI_FETCHER_URL,
  PAGE_MESSAGE,
  PAGE_PREVIEW_MESSAGE,
  displayTitle,
  externalEntry,
  isLoadedSong,
  lazySourcesNeeded,
  loadCatalog as loadCatalogFiles,
  localEntry,
  openEntry,
  shouldPrefetch,
} from "../core/sources.js";
import { downloadStartedMessage, looksLikeDownload, openDownloadedFile } from "./downloaded-file.js";
import { loadAbcjs as loadAbcjsParser } from "./input-panel.js";
import { notify, statusToast } from "./notify.js";
import { createSongShelf } from "./song-shelf.js";

/** How long the visitor must stop typing before the online sources are asked, in milliseconds. */
export const SEARCH_PAUSE_MS = DEBOUNCE_MS;

/** The shortest query worth sending to other sites. */
export const MIN_SEARCH_LENGTH = MIN_QUERY_LENGTH;

/** How long after the first paint the big catalog file is fetched ahead, if the browser is not busy. */
const PREFETCH_DELAY_MS = 1500;

/**
 * Save a file from another site through a temporary link: the browser downloads it.
 *
 * @param {string} url
 * @param {string} name the file name to save it as
 */
function downloadThroughLink(url, name) {
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  link.target = "_blank";
  document.body.append(link);
  link.click();
  link.remove();
}

/**
 * What the glue needs from the page. Everything after `playIntro` has a default for the real page.
 *
 * @typedef {object} CatalogGlueParts
 * @property {HTMLElement} shelfRoot where the song shelf is built (`[data-shelf]`)
 * @property {{status: HTMLElement, forgetNote: HTMLElement, forgetButton: HTMLElement, openFileButton: HTMLElement, fileInput: HTMLInputElement}} elements
 *   the Song card's status line, the "Downloaded songs" note and its button, the Open MIDI or ABC
 *   button and the hidden file input
 * @property {() => any} inputPanel the input panel (`readFile`, `current`); a function because the
 *   panel is built first and calls back into the glue
 * @property {() => boolean} isEvolving true while a run is going
 * @property {(discard: boolean) => void} stopRun
 * @property {() => void} startRun start a run on the loaded song
 * @property {() => void} playIntro play the loaded song's first bars in the Result player
 * @property {typeof fetch} [fetchFn]
 * @property {string | null} [fetcherUrl] the MIDI fetcher Worker's address (default: the deployed
 *   one); null for no Worker, and songs on other sites keep the download-and-open flow
 * @property {() => number} [now] the clock, for the Worker's cool-down (default `Date.now`)
 * @property {Array<import("../core/online-sources.js").OnlineSource>} [onlineSources] the sources the
 *   search box asks (default: The Session, BitMidi, midis101.com, Mutopia and IMSLP)
 * @property {() => boolean} [isOnline] default: the browser's `navigator.onLine`
 * @property {(text: string, options?: import("./notify.js").NotifyOptions) => unknown} [toast] a
 *   toast with an optional action (`notify.js`)
 * @property {(run: () => void) => void} [idle] run something when the browser is idle (default
 *   `requestIdleCallback`, or a timer)
 * @property {{saveData?: boolean, effectiveType?: string, type?: string}} [connection] default
 *   `navigator.connection`
 * @property {typeof createSongShelf} [createShelf]
 * @property {typeof loadCatalogFiles} [loadCatalog]
 * @property {ReturnType<typeof createSongCache>} [songCache]
 * @property {(text: string, isError?: boolean) => void} [notifyStatus] the toast relay (`notify.js`)
 * @property {() => Promise<any>} [loadAbcjs]
 * @property {{open: (url: string, target: string, features: string) => unknown, showOpenFilePicker?: unknown}} [win]
 * @property {(url: string, name: string) => void} [download]
 * @property {(run: () => void, ms: number) => any} [setTimer]
 * @property {(id: any) => void} [clearTimer]
 */

/**
 * Build the shelf and wire it to the catalog, the song cache, The Session and the downloads.
 *
 * @param {CatalogGlueParts} parts
 * @example
 * const catalog = createCatalogGlue({ shelfRoot, elements, inputPanel: () => inputPanel, isEvolving, stopRun, startRun, playIntro });
 * catalog.claimDownload("Aquarela (1).mid"); // the record the visitor meant, or null
 */
export function createCatalogGlue(parts) {
  const { elements } = parts;
  const fetchFn = parts.fetchFn ?? ((/** @type {any} */ input, /** @type {any} */ init) => fetch(input, init));
  const win = parts.win ?? globalThis.window;
  const download = parts.download ?? downloadThroughLink;
  const notifyStatus = parts.notifyStatus ?? statusToast;
  const toast = parts.toast ?? ((/** @type {string} */ text, /** @type {any} */ options) => notify(text, options));
  const fetcherUrl = parts.fetcherUrl === undefined ? MIDI_FETCHER_URL : parts.fetcherUrl;
  const readAbcjs = parts.loadAbcjs ?? loadAbcjsParser;
  const setTimer = parts.setTimer ?? ((/** @type {() => void} */ run, /** @type {number} */ ms) => setTimeout(run, ms));
  const clearTimer = parts.clearTimer ?? ((/** @type {any} */ id) => clearTimeout(id));
  const songCache = parts.songCache ?? createSongCache(browserSongStore());
  const inputPanel = parts.inputPanel;
  const health = createFetcherHealth({ now: parts.now ?? (() => Date.now()), coolDownMs: COOL_DOWN_MS });
  /** @type {Set<string>} songs the Worker could not bring in this visit (the song itself is the trouble) */
  const failedKeys = new Set();
  const keyOf = (/** @type {{id: string, source?: string}} */ entry) => cacheKey(entry);

  /**
   * Whether the Worker can be counted on to bring this song's file now: it serves the song's
   * site, it has not just failed, and it did not fail for this song.
   *
   * @param {any} entry
   * @returns {boolean}
   */
  const workerCanBring = (entry) => fetcherUrl !== null && isFetchable(entry) && health.isUp() && !failedKeys.has(keyOf(entry));

  /**
   * The registry's collections (`data/catalog/collections.json`), as far as they have been read.
   * Until the registry arrives, the built-in ones: the playlists then are the ones the app always had.
   */
  let catalogCollections = FALLBACK_COLLECTIONS;
  /** @type {any[]} the catalog's songs, as far as they have been read */
  let catalogEntries = [];
  /** @type {any[]} the visitor's own files, as records, newest first */
  const ownEntries = [];
  /** @type {Map<string, {name: string, bytes: Uint8Array}>} the files behind those records */
  const ownFiles = new Map();
  /** @type {Set<string>} the lazy catalog files not read yet */
  let pendingSources = new Set(FALLBACK_COLLECTIONS.filter((record) => record.lazy).map((record) => record.id));
  /**
   * The song whose downloaded file the visitor is about to choose through the hidden file input
   * (browsers without the native picker). The input panel asks `claimDownload` who a chosen file is.
   *
   * @type {{entry: any, name: string} | null}
   */
  let awaitedDownload = null;

  const shelf = (parts.createShelf ?? createSongShelf)(parts.shelfRoot, {
    entries: [],
    onSearch: (query) => onlineSearch.query(query),
    onRetrySearch: () => onlineSearch.retry(),
    onArrange: async (entry) => {
      if (await openCatalogEntry(entry)) parts.startRun();
    },
    onPreview: async (entry) => {
      if (await openCatalogEntry(entry, { openPages: false })) parts.playIntro();
    },
    onDownload: (entry) => startDownload(entry),
    onOpenDownloaded: (entry) => openDownloaded(entry),
    // A song the browser kept, or the Worker can bring, opens in one click, like a song of the repository.
    isOneClick: (entry) => songCache.has(entry) || workerCanBring(entry),
    setTimer,
    clearTimer,
    collections: () => catalogCollections,
    // A lazy file (MPB's is the biggest) is read when the visitor opens its playlist or searches.
    pendingSources: FALLBACK_COLLECTIONS.filter((record) => record.lazy).map((record) => record.id),
    onNeedSongs: (sources) => loadMoreSongs(sources),
  });

  /**
   * Say something to the visitor: in the Song card's status line, and as a toast.
   *
   * @param {string} text an empty text clears both
   * @param {boolean} [isError]
   */
  function songStatus(text, isError = false) {
    elements.status.textContent = text;
    elements.status.classList.toggle("error", isError);
    notifyStatus(text, isError);
  }

  function showSongs() {
    shelf.setEntries([...ownEntries, ...catalogEntries]);
  }

  /**
   * Put a file the visitor opened on the shelf, at its head and selected, so it can be found and
   * arranged again later in the visit. The same file twice keeps its one record.
   *
   * @param {any} entry the record (`localEntry`)
   * @param {{name: string, bytes: Uint8Array}} file the file behind it
   */
  function addOwnEntry(entry, file) {
    const known = ownEntries.findIndex((own) => own.id === entry.id);
    if (known < 0) {
      ownEntries.unshift(entry);
      ownFiles.set(entry.id, file);
    }
    shelf.setQuery("");
    showSongs();
    shelf.select(known < 0 ? 0 : known);
  }

  /**
   * A file the visitor opened (dropped, chosen or from a link) gets its own record at the head of
   * the shelf, selected.
   *
   * @param {any} loaded the input panel's loaded song
   */
  function rememberOwnSong(loaded) {
    const { input } = loaded;
    if (input.catalogEntry) return; // a shelf song, or one matched to a shelf song
    const entry = localEntry({ name: input.name, sha256: input.sha256, leadSheet: loaded.leadSheet });
    addOwnEntry(entry, { name: input.name, bytes: input.bytes });
  }

  // --- The catalog ----------------------------------------------------------------------------

  /**
   * How much of a lazy file has arrived: the shelf draws a bar from it. A file that is done (or
   * failed) is reported as null by `loadMoreSongs`.
   *
   * @param {string} source
   * @param {{loaded: number, total: number}} reading
   */
  function onCatalogProgress(source, reading) {
    shelf.setProgress?.(source, reading);
  }

  const catalogLoading = parts.loadCatalog
    ? parts.loadCatalog(fetchFn, onCatalogUpdate, onCatalogProgress)
    : loadCatalogFiles(fetchFn, onCatalogUpdate, onCatalogProgress);
  catalogLoading
    .then(({ entries }) => {
      if (entries.length === 0) throw new Error("empty catalog");
    })
    .catch(() => songStatus("The catalog could not be loaded. You can still open your own MIDI or ABC file.", true));

  /**
   * @param {any[]} entries
   * @param {{collections: any, pending: string[]}} view
   */
  function onCatalogUpdate(entries, view) {
    catalogEntries = entries;
    catalogCollections = view.collections;
    pendingSources = new Set(view.pending);
    shelf.setPending(view.pending);
    showSongs();
  }

  /**
   * Read the larger catalog files the visitor now needs, and tell the shelf when they are in.
   *
   * @param {string[]} sources
   */
  async function loadMoreSongs(sources) {
    let failed = false;
    try {
      const catalog = await catalogLoading;
      const results = await Promise.all(sources.map((source) => catalog.loadMore(source)));
      failed = results.some((result) => sources.some((source) => result.missing.includes(source)));
    } catch {
      failed = true;
    }
    for (const source of sources) {
      pendingSources.delete(source);
      shelf.setProgress?.(source, null);
    }
    shelf.setPending([...pendingSources]);
    if (failed) songStatus("More songs could not be loaded. Check your connection and reload the page.", true);
  }

  // Songs kept from an earlier visit join Catalog, which needs their records: read their file now.
  // The big file the visitor will probably need is read ahead, once the browser is idle, unless
  // the connection is metered or slow: then the first search is the first to pay for it.
  Promise.all([songCache.load(), catalogLoading])
    .then(() => {
      const needed = lazySourcesNeeded({ playlistId: null, searching: false, cachedKeys: songCache.keys() }, catalogCollections);
      if (needed.length > 0) loadMoreSongs(needed);
      if (songCache.size > 0) showSongs();
      showForgetAction();
      prefetchLazySources(needed);
    })
    .catch(() => {}); // a catalog that failed is reported above

  /**
   * Read the lazy catalog files ahead of need while the browser is idle.
   *
   * @param {string[]} alreadyAsked sources that are being read already
   */
  function prefetchLazySources(alreadyAsked) {
    const connection = parts.connection ?? /** @type {any} */ (globalThis.navigator)?.connection;
    if (!shouldPrefetch(connection)) return;
    const idle = parts.idle ?? ((/** @type {() => void} */ run) => (globalThis.requestIdleCallback ? globalThis.requestIdleCallback(() => run()) : setTimer(run, PREFETCH_DELAY_MS)));
    idle(() => {
      const wanted = [...pendingSources].filter((source) => !alreadyAsked.includes(source));
      if (wanted.length > 0) loadMoreSongs(wanted);
    });
  }

  /** The quiet "Forget downloaded songs" paragraph of the How it works tab: shown only when there is something to forget. */
  function showForgetAction() {
    elements.forgetNote.hidden = songCache.size === 0;
  }
  elements.forgetButton.addEventListener("click", async () => {
    await songCache.forget();
    showForgetAction();
    showSongs();
  });

  /**
   * Keep the file of a downloadable song the visitor just opened, so the next visit needs no
   * download. Only a file whose SHA-256 is the one the record names is kept (`core/song-cache.js`);
   * a song with no recorded hash (a search result) is kept as first downloaded.
   *
   * @param {any} loaded the input panel's loaded song
   */
  async function rememberDownload(loaded) {
    const { input } = loaded;
    const entry = input.catalogEntry;
    if (!entry || entry.route?.download === undefined || songCache.has(entry)) return;
    // A song found by a search has no recorded hash: its first download is trusted (and the
    // copy is checked against itself later). A catalog record's own hash still judges its file.
    if ((await songCache.remember(entry, input.bytes, input.sha256, { trustFirstDownload: true })) === "stored") {
      showForgetAction();
      showSongs();
      toast("Saved in this browser: it opens at once next time.");
    }
  }

  elements.openFileButton.addEventListener("click", () => elements.fileInput.click());

  // --- Online search ---------------------------------------------------------------------------

  /** The query the visitor's failed-source toast was last shown for, so it appears once per search. */
  let toastedFor = "";

  /**
   * The online search's state changed: hand the shelf the results so far and where the search
   * stands, unless the visitor has already typed something else. A search that ended with a
   * failure says so in a toast, with Retry, because the line under the search box is easy to miss.
   *
   * @param {import("../core/online-search.js").OnlineState} state
   */
  function onOnlineChange(state) {
    if (shelf.searchBox.value.trim() !== state.query && state.active) return;
    shelf.setExternal(state.results.map(externalEntry), state);
    const failureKey = `${state.query}|${state.failed.map((source) => source.id).join(",")}`;
    if (!state.searching && !state.offline && state.failed.length > 0 && toastedFor !== failureKey) {
      toastedFor = failureKey;
      const names = state.failed.map((source) => source.name).join(", ");
      toast(`${names} could not be reached. Showing the other results.`, { kind: "error", action: { label: "Retry", run: () => onlineSearch.retry() } });
    }
    if (state.offline && toastedFor !== `offline|${state.query}`) {
      toastedFor = `offline|${state.query}`;
      toast("You are offline: only the catalog and your downloaded songs can be searched.", { kind: "error", action: { label: "Retry", run: () => onlineSearch.retry() } });
    }
  }

  const onlineSearch = createOnlineSearch({
    sources: parts.onlineSources ?? createOnlineSources({ fetchFn, workerUrl: fetcherUrl ?? MIDI_FETCHER_URL }),
    onChange: onOnlineChange,
    isOnline: parts.isOnline,
    setTimer,
    clearTimer,
  });

  /**
   * Search the online sources now (the box does it after a pause by itself).
   *
   * @param {string} query
   */
  function searchElsewhere(query) {
    onlineSearch.query(query);
  }

  // --- Downloads ------------------------------------------------------------------------------

  /**
   * The "Download MIDI" button of a record: save the song's MIDI file under `<Title>.mid`. The
   * page cannot fetch it (its site sends no CORS header), so the browser saves it and the visitor
   * gives it back with "Open downloaded file".
   *
   * @param {any} entry
   */
  async function startDownload(entry) {
    try {
      const song = await openEntry(entry, { fetchFn });
      if (song.kind !== "link") return;
      download(song.url, song.name);
      songStatus(downloadStartedMessage(song.name, win));
    } catch (error) {
      songStatus(/** @type {Error} */ (error).message ?? String(error), true);
    }
  }

  /**
   * The "Open downloaded file" button of a record: a file dialog, in the Downloads folder where the
   * browser can. The chosen file opens as the record's song, as if it were dropped on the page. The
   * page cannot read the folder itself, so the visitor still confirms the file in the dialog.
   *
   * @param {any} entry
   */
  async function openDownloaded(entry) {
    try {
      // Opening a link entry reads nothing from the network; it only gives the file name.
      const song = await openEntry(entry, { fetchFn });
      awaitedDownload = { entry, name: song.name };
      const how = await openDownloadedFile({
        win,
        fileInput: elements.fileInput,
        onFile: (file) => inputPanel().readFile(file, entry.facts?.overrides ?? {}, entry),
      });
      // Only the file input still waits for a file (its change event asks claimDownload).
      if (how !== "input") awaitedDownload = null;
    } catch (error) {
      songStatus(/** @type {Error} */ (error).message ?? String(error), true);
    }
  }

  /**
   * Tell the input panel which record a chosen file is, when the visitor opened the dialog for a
   * downloaded song and chose a file of its name.
   *
   * @param {string} name the chosen file's name
   * @returns {any} the record, or null when the file is the visitor's own
   */
  function claimDownload(name) {
    const waiting = awaitedDownload;
    awaitedDownload = null;
    return waiting && looksLikeDownload(name, waiting.name) ? waiting.entry : null;
  }

  // --- Opening a record -----------------------------------------------------------------------

  /**
   * Bring a song's file through the Worker and load it into the input panel. When the Worker
   * cannot, say why and leave the song to the download-and-open flow: the shelf's panel then
   * offers "Download MIDI" for it.
   *
   * @param {any} entry a song with a download route that the Worker serves
   * @returns {Promise<boolean>} true when the song was read
   */
  async function openThroughWorker(entry) {
    const title = displayTitle(entry.t);
    songStatus(`Loading ${title}…`);
    const outcome = await fetchMidiFile(entry, { fetchFn, base: /** @type {string} */ (fetcherUrl) });
    if (!outcome.ok) {
      health.recordFailure(outcome);
      if (!outcome.systemic) failedKeys.add(keyOf(entry));
      showSongs(); // the song is no longer one click: the shelf offers the download
      songStatus(`${title} could not be fetched automatically. ${failureMessage(outcome.kind)}`, true);
      return false;
    }
    health.recordSuccess();
    try {
      const before = inputPanel().current();
      const named = await openEntry(entry, { fetchFn }); // reads nothing; it gives the file name
      await inputPanel().readFile(new File([outcome.bytes], named.name), entry.facts?.overrides ?? {}, entry);
      return inputPanel().current() !== before && inputPanel().current() !== null;
    } catch (error) {
      songStatus(/** @type {Error} */ (error).message ?? String(error), true);
      return false;
    }
  }

  /**
   * Load a catalog song into the input panel, as if its file were dropped.
   *
   * @param {any} entry
   * @param {{openPages?: boolean}} [options] `openPages: false` (Preview) never opens a page
   * @returns {Promise<boolean>} true when the song was read
   */
  async function openCatalogEntry(entry, { openPages = true } = {}) {
    // The song is already read, and the visitor may have chosen its melody track and bars: reading
    // it again would put the likeliest track back. A run in progress is cancelled, as a new song does.
    if (isLoadedSong(entry, inputPanel().current()?.input ?? null)) {
      if (parts.isEvolving()) parts.stopRun(true);
      return true;
    }
    const own = ownFiles.get(entry.id);
    if (entry.route?.local && own) {
      const before = inputPanel().current();
      await inputPanel().readFile(new File([own.bytes], own.name), {}, entry);
      return inputPanel().current() !== before && inputPanel().current() !== null;
    }
    if (entry.route?.download !== undefined) {
      // A song downloaded before is read from this browser, with the record's own limits.
      const kept = songCache.has(entry);
      const bytes = await songCache.bytesOf(entry);
      if (bytes) {
        const before = inputPanel().current();
        const named = await openEntry(entry, { fetchFn }); // reads nothing; it gives the file name
        await inputPanel().readFile(new File([bytes], named.name), entry.facts?.overrides ?? {}, entry);
        return inputPanel().current() !== before && inputPanel().current() !== null;
      }
      if (kept) showSongs(); // the kept file was damaged: the song asks for its download again
      if (workerCanBring(entry)) return openThroughWorker(entry);
    }
    songStatus(`Loading ${displayTitle(entry.t)}…`);
    try {
      const abcjs = entry.route?.thesession !== undefined ? await readAbcjs() : undefined;
      const song = await openEntry(entry, { fetchFn, abcjs });
      if (song.kind === "link") {
        if (song.byHand) {
          if (openPages) download(song.url, song.name);
          songStatus(openPages ? PAGE_MESSAGE : PAGE_PREVIEW_MESSAGE);
        } else {
          if (openPages) win.open(song.url, "_blank", "noopener");
          songStatus("");
        }
        return false;
      }
      const before = inputPanel().current();
      const bytes = song.kind === "abc" ? new TextEncoder().encode(song.text) : song.bytes;
      await inputPanel().readFile(new File([bytes], song.name), entry.facts?.overrides ?? {}, entry);
      return inputPanel().current() !== before && inputPanel().current() !== null;
    } catch (error) {
      songStatus(/** @type {Error} */ (error).message ?? String(error), true);
      return false;
    }
  }

  return {
    shelf,
    songCache,
    catalogLoading,
    songStatus,
    showSongs,
    addOwnEntry,
    rememberOwnSong,
    rememberDownload,
    claimDownload,
    openCatalogEntry,
    loadMoreSongs,
    searchElsewhere,
    startDownload,
    openDownloaded,
  };
}
