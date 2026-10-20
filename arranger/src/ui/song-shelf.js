// @ts-check
/**
 * Song shelf: the whole catalog as pages of vinyl records, with a panel for the selected song
 * (spec 005, story 3, FR-009 to FR-014a, research R6 and R7).
 *
 * The look takes after the PS2 memory card screen: records float over the Song card, the
 * selected one comes forward and spins, and the others bob. Thousands of songs cannot float
 * at once, so the catalog is cut into pages of 15 records (9 on a phone); only the current page
 * exists in the scene, which keeps paging smooth (story 3, scenario 7).
 *
 * The truth lives in the DOM, not in the 3D scene:
 *
 * - A listbox (`role=listbox`) holds the current page's songs as options, and
 *   `aria-activedescendant` names the selected one. Keyboards and screen readers use it:
 *   arrows move by record and by row and cross page edges, Home and End jump to the ends of
 *   the page, PageUp and PageDown turn pages, Enter arranges.
 * - With WebGL, the three.js scene (`shelf-scene.js`, loaded only then) draws the page and
 *   reports clicks on records; the listbox is hidden from sight but keeps the focus.
 * - Without WebGL, or when the GPU drops the context, the same listbox is shown as a 2D grid of
 *   sprite canvases, with the same keys and the same selection.
 *
 * The side panel shows the selected song's sprite, title, composer and its analysis facts as
 * labeled values (key, tempo, meter, bars), with Arrange and Preview. It never shows where a
 * song comes from: credits live in the README (FR-014a).
 */

import { MIN_QUERY_LENGTH, normalize } from "../core/catalog.js";
import { displayTitle, mergeSearchResults, pageCount, pageOf, searchCatalog } from "../core/sources.js";
import { SHELF_ROWS, shelfColumns } from "./shelf-layout.js";
import { SPRITE_SIZE, drawSprite, entrySprite } from "./sprites.js";

/** @typedef {import("../core/sources.js").CatalogEntry} CatalogEntry */
/** @typedef {import("../core/sources.js").SearchResult} SearchResult */

/**
 * @typedef {object} ShelfScene what `shelf-scene.js` `createShelfScene` returns
 * @property {(entries: CatalogEntry[], selectedIndex: number, columns?: number) => void} setPage
 * @property {(index: number) => void} select index on the page
 * @property {(callback: (index: number) => void) => void} onPick called with the index on the
 *   page of a clicked record
 * @property {() => void} resize
 * @property {() => void} dispose
 */

/**
 * @typedef {object} ShelfOptions
 * @property {CatalogEntry[]} [entries] the catalog; it may grow later (`setEntries`)
 * @property {(entry: CatalogEntry) => void} onArrange opens the song in the reading flow
 * @property {(entry: CatalogEntry) => void} [onPreview] plays the song; no Preview without it
 * @property {boolean} [webgl] draw the 3D scene; default: the browser has WebGL 2 and the
 *   address has no `?no-webgl`
 * @property {boolean} [reducedMotion] no bobbing or spinning; default: the visitor's setting
 * @property {() => Promise<{createShelfScene: (host: HTMLElement, options: {reducedMotion: boolean}) => ShelfScene}>} [sceneFactory]
 *   loads the scene module; default `import("./shelf-scene.js")`
 */

/**
 * @typedef {object} ShelfPage the shelf's state, for the page and for tests
 * @property {number} page 0 for the first page
 * @property {number} pages
 * @property {number} perPage
 * @property {number} columns
 * @property {number} index the selected song, in the whole (filtered) list
 * @property {number} total songs in the list
 * @property {CatalogEntry[]} entries the current page's songs
 */

/**
 * @typedef {object} SongShelf
 * @property {(entries: CatalogEntry[]) => void} setEntries replace the catalog, keeping the
 *   selected song when it is still there
 * @property {(query: string) => void} setQuery filter by the search box's words
 * @property {(results: Array<SearchResult | CatalogEntry>) => void} setExternal external results
 *   for the current query, shown after the local matches
 * @property {(index: number) => void} select select a song of the list
 * @property {() => ShelfPage} page
 * @property {() => CatalogEntry | null} selected
 * @property {() => void} focus put the keyboard focus on the shelf
 * @property {() => void} resize measure the stage again (also done on its own when it resizes)
 * @property {() => void} destroy
 */

/** Keys the shelf moves with; they never scroll the page, even at the ends. */
const MOVE_KEYS = new Set(["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"]);

const UNKNOWN = "—";

let shelfCount = 0;

/**
 * The song a key moves to, in the whole list.
 *
 * The selection is one index in the whole list, so crossing a page edge needs no special case:
 * ArrowRight on a page's last record is simply the next song, which sits on the next page.
 *
 * @param {number} index the selected song
 * @param {string} key `KeyboardEvent.key`
 * @param {{total: number, columns: number, perPage: number}} shape
 * @returns {number | null} the new index, or null when the key does not move
 * @example
 * stepSelection(14, "ArrowRight", { total: 40, columns: 5, perPage: 15 }); // 15, on page 2
 * stepSelection(4, "PageDown", { total: 40, columns: 5, perPage: 15 }); // 19, same place
 */
export function stepSelection(index, key, { total, columns, perPage }) {
  if (total === 0) return null;
  const page = Math.floor(index / perPage);
  const lastPage = Math.floor((total - 1) / perPage);
  switch (key) {
    case "ArrowRight":
      return index + 1 < total ? index + 1 : null;
    case "ArrowLeft":
      return index > 0 ? index - 1 : null;
    case "ArrowDown":
      if (index + columns < total) return index + columns;
      // The row below is short: go to the last song, if it is on a lower row.
      return Math.floor(index / columns) < Math.floor((total - 1) / columns) ? total - 1 : null;
    case "ArrowUp":
      return index >= columns ? index - columns : null;
    case "Home":
      return page * perPage;
    case "End":
      return Math.min(total, (page + 1) * perPage) - 1;
    case "PageDown":
      return page < lastPage ? Math.min(index + perPage, total - 1) : null;
    case "PageUp":
      return page > 0 ? index - perPage : null;
    default:
      return null;
  }
}

/**
 * A key name as a reader writes it: "e- minor" (music21) becomes "Eb minor".
 *
 * @param {string} keyName
 * @returns {string} "—" when unknown
 * @example
 * keyLabel("e- minor"); // "Eb minor"
 */
export function keyLabel(keyName) {
  const name = keyName.trim();
  if (name === "") return UNKNOWN;
  const parts = /^([A-Ga-g])([#-]*)\s*(.*)$/.exec(name);
  if (parts === null) return name;
  const mode = parts[3] === "m" ? "minor" : parts[3];
  return `${parts[1].toUpperCase()}${parts[2].replaceAll("-", "b")}${mode ? ` ${mode}` : ""}`;
}

/**
 * The facts the panel shows, as [label, value] pairs.
 *
 * @param {CatalogEntry} entry
 * @returns {Array<[string, string]>}
 * @example
 * factsOf({ id: "a", t: "A", facts: { key: "G major", tempo_bpm: 96.5, meter: "2/4", n_bars: 48 } });
 * // [["Key", "G major"], ["Tempo", "97 BPM"], ["Meter", "2/4"], ["Bars", "48"]]
 */
export function factsOf(entry) {
  const facts = entry.facts ?? {};
  return [
    ["Key", facts.key ? keyLabel(facts.key) : UNKNOWN],
    ["Tempo", facts.tempo_bpm ? `${Math.round(facts.tempo_bpm)} BPM` : UNKNOWN],
    ["Meter", facts.meter || UNKNOWN],
    ["Bars", facts.n_bars ? String(facts.n_bars) : UNKNOWN],
  ];
}

/**
 * Whether to draw the 3D scene: the browser has WebGL 2 (three.js needs it), and the address
 * does not ask for the 2D grid with `?no-webgl` (used to check the fallback). A GPU that still
 * refuses a context makes the scene throw, and the shelf falls back then.
 *
 * @param {{WebGL2RenderingContext?: unknown, location?: {search: string}}} scope `globalThis`
 * @returns {boolean}
 * @example
 * webglAvailable(globalThis); // true in a browser with WebGL 2
 */
export function webglAvailable(scope) {
  if (typeof scope.WebGL2RenderingContext !== "function") return false;
  return !/[?&]no-webgl(?:[=&]|$)/.test(scope.location?.search ?? "");
}

/** @returns {boolean} whether the visitor asked the system for reduced motion */
function prefersReducedMotion() {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** @param {CatalogEntry} entry */
const keyOf = (entry) => `${entry.source}:${entry.id}`;

/** @param {CatalogEntry} entry */
const canArrange = (entry) => Boolean(entry.route) && !entry.error;

/**
 * Build the shelf inside `root`.
 *
 * @param {HTMLElement} root an empty element in the Song card
 * @param {ShelfOptions} options
 * @returns {SongShelf}
 * @example
 * const shelf = createSongShelf(document.querySelector("[data-shelf]"), { entries, onArrange, onPreview });
 * searchBox.addEventListener("input", () => shelf.setQuery(searchBox.value));
 */
export function createSongShelf(root, options) {
  const doc = root.ownerDocument;
  const id = `shelf-${++shelfCount}`;
  const reducedMotion = options.reducedMotion ?? prefersReducedMotion();
  const webgl = options.webgl ?? webglAvailable(/** @type {any} */ (globalThis));

  /** @type {CatalogEntry[]} */
  let entries = options.entries ?? [];
  let query = "";
  /** @type {Array<SearchResult | CatalogEntry>} */
  let external = [];
  /** @type {CatalogEntry[]} the catalog, or the matches of the query */
  let list = entries;
  let index = 0;
  let columns = 5;
  let perPage = columns * SHELF_ROWS;
  /** @type {{list: CatalogEntry[], page: number, perPage: number} | null} what the options show */
  let shown = null;
  /** @type {HTMLElement[]} */
  let optionElements = [];
  /** @type {HTMLElement[]} the rows of the visible list beside the records */
  let songRows = [];
  /** @type {ShelfScene | null} */
  let scene = null;
  let destroyed = false;

  /**
   * @param {string} tag
   * @param {string} [classes] space-separated
   * @param {Record<string, string | number>} [attributes]
   * @returns {any}
   */
  const make = (tag, classes = "", attributes = {}) => {
    const element = doc.createElement(tag);
    if (classes) element.classList.add(...classes.split(" "));
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
    return element;
  };
  /** @param {string} tag @param {string} classes @param {string} text */
  const textElement = (tag, classes, text) => {
    const element = make(tag, classes);
    element.textContent = text;
    return element;
  };

  const canvasHost = make("div", "shelf-canvas", { "aria-hidden": "true" });
  const listbox = make("ul", "shelf-list", { role: "listbox", tabindex: 0, id: `${id}-list` });
  const empty = make("p", "shelf-empty");
  const stage = make("div", "shelf-stage");
  stage.append(canvasHost, listbox, empty);
  const info = make("aside", "shelf-info", { "aria-label": "Selected song" });
  // The records do not say which song they are: this list does. The listbox above is the
  // accessible one, so the list is hidden from assistive technology rather than read twice.
  const songs = make("ol", "shelf-songs", { "aria-hidden": "true" });
  const body = make("div", "shelf-body");
  body.append(stage, songs, info);
  const previous = make("button", "button small", { type: "button", "aria-label": "Previous page" });
  previous.textContent = "‹";
  const next = make("button", "button small", { type: "button", "aria-label": "Next page" });
  next.textContent = "›";
  const pageText = make("span", "shelf-page mono", { "aria-live": "polite" });
  const pager = make("div", "shelf-pager");
  pager.append(previous, pageText, next);

  root.classList.add("song-shelf", webgl ? "is-3d" : "is-2d");
  root.classList.toggle("reduce-motion", reducedMotion);
  root.append(body, pager);

  function measure() {
    columns = shelfColumns(stage.clientWidth || root.clientWidth || 0);
    perPage = columns * SHELF_ROWS;
    root.style.setProperty("--shelf-columns", String(columns));
  }

  /** @returns {{page: number, start: number, pageEntries: CatalogEntry[]}} */
  function currentPage() {
    const page = Math.floor(index / perPage);
    return { page, start: page * perPage, pageEntries: pageOf(list, page, perPage) };
  }

  /**
   * One option of the listbox: the record (a sprite on a label in a channel color) and the
   * song's name for assistive technology.
   *
   * @param {CatalogEntry} entry
   * @param {number} position index in the whole list
   */
  function buildOption(entry, position) {
    const option = make("li", "shelf-record", {
      role: "option",
      id: `${id}-song-${position}`,
      "aria-selected": "false",
      "aria-posinset": position + 1,
      "aria-setsize": list.length,
    });
    const sprite = entrySprite(entry);
    const disc = make("span", "shelf-disc", { "aria-hidden": "true" });
    disc.style.setProperty("--label", sprite.label);
    disc.append(spriteCanvas(entry));
    const names = [displayTitle(entry.t), entry.c || entry.p || ""].filter(Boolean).join(", ");
    option.append(disc, textElement("span", "shelf-record-name", entry.error ? `${names}, cannot be arranged` : names));
    option.addEventListener("click", () => {
      select(position);
      listbox.focus();
    });
    return option;
  }

  /**
   * One row of the visible list: a dot in the record's label color, the title, and who made it.
   * A click selects the song; a double click arranges it.
   *
   * @param {CatalogEntry} entry
   * @param {number} position index in the whole list
   */
  function buildSongRow(entry, position) {
    const row = make("li", "shelf-song");
    const dot = make("i", "shelf-dot");
    dot.style.setProperty("--label", entrySprite(entry).label);
    row.append(dot, textElement("span", "shelf-song-title", displayTitle(entry.t)));
    const by = entry.c || entry.p || "";
    if (by) row.append(textElement("span", "shelf-song-by", by));
    row.addEventListener("click", () => select(position));
    row.addEventListener("dblclick", () => {
      if (canArrange(entry)) options.onArrange(entry);
    });
    return row;
  }

  /** @param {CatalogEntry} entry */
  function spriteCanvas(entry) {
    const canvas = make("canvas", "shelf-sprite");
    canvas.width = SPRITE_SIZE;
    canvas.height = SPRITE_SIZE;
    const context = canvas.getContext("2d");
    if (context) drawSprite(context, entrySprite(entry), 0, 0, 1);
    return canvas;
  }

  /** @param {CatalogEntry | null} entry */
  function renderInfo(entry) {
    if (!entry) {
      info.replaceChildren(textElement("p", "shelf-by", "Pick a song, or open your own MIDI or ABC file."));
      return;
    }
    const names = make("div", "shelf-names");
    names.append(textElement("h3", "shelf-title", displayTitle(entry.t)));
    const by = entry.c || entry.p || "";
    if (by) names.append(textElement("p", "shelf-by", by));
    if (entry.p && entry.c && entry.p !== entry.c) names.append(textElement("p", "shelf-performer", entry.p));
    if (entry.variant) {
      const [number, count] = entry.variant.split("/");
      names.append(textElement("p", "shelf-variant", `Version ${number} of ${count}`));
    }
    const head = make("div", "shelf-info-head");
    head.append(spriteCanvas(entry), names);

    const facts = make("dl", "shelf-facts");
    for (const [label, value] of factsOf(entry)) {
      const fact = make("div");
      fact.append(textElement("dt", "", label), textElement("dd", "", value));
      facts.append(fact);
    }

    info.replaceChildren(head, facts);
    if (!canArrange(entry)) {
      const reason = entry.error ? ` (${entry.error})` : "";
      info.append(textElement("p", "shelf-problem", `This song cannot be arranged${reason}.`));
      return;
    }
    const actions = make("div", "shelf-actions");
    const link = entry.route?.link !== undefined;
    const arrange = make("button", "button primary", { type: "button" });
    arrange.textContent = link ? "Open page" : "Arrange";
    arrange.addEventListener("click", () => options.onArrange(entry));
    actions.append(arrange);
    if (options.onPreview && !link) {
      const preview = make("button", "button", { type: "button" });
      preview.textContent = "Preview";
      preview.addEventListener("click", () => options.onPreview?.(entry));
      actions.append(preview);
    }
    info.append(actions);
  }

  function render() {
    const total = list.length;
    index = Math.max(0, Math.min(index, total - 1));
    const { page, start, pageEntries } = currentPage();
    const pages = pageCount(total, perPage);

    if (!shown || shown.list !== list || shown.page !== page || shown.perPage !== perPage) {
      optionElements = pageEntries.map((entry, i) => buildOption(entry, start + i));
      listbox.replaceChildren(...optionElements);
      songRows = pageEntries.map((entry, i) => buildSongRow(entry, start + i));
      songs.replaceChildren(...songRows);
      shown = { list, page, perPage };
      scene?.setPage(pageEntries, index - start, columns);
    } else {
      scene?.select(index - start);
    }

    optionElements.forEach((option, i) => option.setAttribute("aria-selected", String(start + i === index)));
    songRows.forEach((row, i) => row.classList.toggle("is-selected", start + i === index));
    songRows[index - start]?.scrollIntoView?.({ block: "nearest" });
    if (total > 0) listbox.setAttribute("aria-activedescendant", `${id}-song-${index}`);
    else listbox.removeAttribute("aria-activedescendant");
    listbox.setAttribute("aria-label", `Songs, page ${page + 1} of ${pages}`);
    pageText.textContent = `Page ${(page + 1).toLocaleString("en")} of ${pages.toLocaleString("en")}`;
    previous.disabled = page === 0;
    next.disabled = page >= pages - 1;
    empty.hidden = total > 0;
    empty.textContent = entries.length === 0 ? "Loading the songs…" : "No song in the catalog matches.";
    renderInfo(list[index] ?? null);
  }

  /** @param {boolean} keepSelection */
  function refilter(keepSelection) {
    const selectedKey = keepSelection && list[index] ? keyOf(list[index]) : null;
    const searching = normalize(query).length >= MIN_QUERY_LENGTH;
    const local = searchCatalog(entries, query);
    list = searching && external.length > 0 ? mergeSearchResults(local, external) : local;
    index = selectedKey ? Math.max(0, list.findIndex((entry) => keyOf(entry) === selectedKey)) : 0;
    render();
  }

  /** @param {number} position */
  function select(position) {
    index = position;
    render();
  }

  /** @param {string} key */
  function move(key) {
    const target = stepSelection(index, key, { total: list.length, columns, perPage });
    if (target !== null) select(target);
  }

  listbox.addEventListener("keydown", (/** @type {KeyboardEvent} */ event) => {
    if (event.key === "Enter") {
      const entry = list[index];
      if (entry && canArrange(entry)) {
        event.preventDefault();
        options.onArrange(entry);
      }
      return;
    }
    if (!MOVE_KEYS.has(event.key)) return;
    event.preventDefault();
    move(event.key);
  });
  stage.addEventListener("click", () => listbox.focus());
  previous.addEventListener("click", () => move("PageUp"));
  next.addEventListener("click", () => move("PageDown"));

  function resize() {
    const before = perPage;
    measure();
    if (perPage !== before) render();
    scene?.resize();
  }
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => resize()) : null;
  observer?.observe(stage);

  /** Drop the 3D scene and show the listbox as the 2D grid; the selection stays. */
  function fallBackTo2d() {
    if (destroyed) return;
    scene?.dispose();
    scene = null;
    root.classList.remove("is-3d");
    root.classList.add("is-2d");
  }

  if (webgl) {
    // Context loss is fired at the canvas and does not bubble, so listen while it descends.
    canvasHost.addEventListener("webglcontextlost", fallBackTo2d, true);
    const load = options.sceneFactory ?? (() => import("./shelf-scene.js"));
    load()
      .then((module) => {
        if (destroyed || !root.classList.contains("is-3d")) return;
        scene = module.createShelfScene(canvasHost, { reducedMotion });
        scene.onPick((onPage) => {
          select(currentPage().start + onPage);
          listbox.focus();
        });
        const { start, pageEntries } = currentPage();
        scene.setPage(pageEntries, index - start, columns);
      })
      .catch(fallBackTo2d);
  }

  measure();
  render();

  return {
    setEntries(next) {
      entries = next;
      refilter(true);
    },
    setQuery(next) {
      query = next;
      external = [];
      refilter(false);
    },
    setExternal(results) {
      external = results;
      refilter(true);
    },
    select,
    page() {
      const { page, pageEntries } = currentPage();
      return { page, pages: pageCount(list.length, perPage), perPage, columns, index, total: list.length, entries: pageEntries };
    },
    selected: () => list[index] ?? null,
    focus: () => listbox.focus(),
    resize,
    destroy() {
      destroyed = true;
      observer?.disconnect();
      scene?.dispose();
      scene = null;
      root.replaceChildren();
      root.classList.remove("song-shelf", "is-3d", "is-2d", "reduce-motion");
    },
  };
}
