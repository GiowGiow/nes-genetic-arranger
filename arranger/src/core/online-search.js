// @ts-check
/**
 * Online search: when the search box asks the online sources, and what it tells the shelf.
 *
 * Typing a word looks through the catalog at once. The online sources (`online-sources.js`) are
 * other people's sites, so they are asked politely:
 *
 * - after a pause in typing (300 ms), not on every key;
 * - once per source per query, all sources together;
 * - a new query aborts the requests of the old one and ignores their late answers;
 * - a source that is silent for 8 seconds is given up on, so the shelf never waits forever;
 * - answers are remembered for the visit, so typing a word again asks nobody; a failure is not
 *   remembered, and `retry` asks only the sources that failed;
 * - offline, nobody is asked, and the state says so.
 *
 * The shelf needs more than the results. While some source has not answered it must not say
 * "no match" (a result may still come), and a failure should be named, not silent. So every
 * change calls `onChange` with the whole state: the results so far in the sources' order, the
 * names of the sources still pending and the ones that failed with a reason.
 *
 * Time and the network are parameters, so the tests run on a clock moved by hand.
 */

/** How long the visitor must stop typing before the sources are asked, in milliseconds. */
export const DEBOUNCE_MS = 300;

/** The shortest query worth sending to other people's sites. */
export const MIN_QUERY_LENGTH = 2;

/** How long one source may take, in milliseconds. */
export const TIMEOUT_MS = 8000;

/**
 * @typedef {import("./online-sources.js").OnlineSource} OnlineSource
 * @typedef {import("./thesession.js").SearchResult} SearchResult
 */

/**
 * @typedef {object} OnlineState what the shelf needs to draw the online part of a search
 * @property {string} query the words searched (trimmed)
 * @property {boolean} active false when no online search is going on (the box is empty or too short)
 * @property {boolean} searching true while some source has not answered
 * @property {boolean} offline the browser is offline, so nobody was asked
 * @property {string[]} pending names of the sources still asked
 * @property {Array<{id: string, name: string, reason: string}>} failed sources that failed, and why
 * @property {SearchResult[]} results the answers so far, in the sources' order
 */

/**
 * @typedef {object} OnlineSearch
 * @property {(text: string) => void} query the visitor typed; asks the sources after a pause
 * @property {() => void} retry ask again the sources that failed for the current query
 * @property {() => void} cancel forget the current query and stop its requests
 */

/**
 * @param {string} text
 * @returns {string} the words as the memory keys them: no case, one space between words
 */
const wordsOf = (text) => text.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Build the online search.
 *
 * @param {object} parts
 * @param {OnlineSource[]} parts.sources in the order their results are listed
 * @param {(state: OnlineState) => void} parts.onChange
 * @param {() => boolean} [parts.isOnline] default: the browser's `navigator.onLine`
 * @param {(run: () => void, ms: number) => any} [parts.setTimer]
 * @param {(id: any) => void} [parts.clearTimer]
 * @returns {OnlineSearch}
 * @example
 * const search = createOnlineSearch({ sources: createOnlineSources({ fetchFn: fetch }), onChange: (state) => shelf.setExternal(state.results.map(externalEntry), state) });
 * searchBox.addEventListener("input", () => search.query(searchBox.value));
 */
export function createOnlineSearch({ sources, onChange, isOnline = () => globalThis.navigator?.onLine !== false, setTimer = (run, ms) => setTimeout(run, ms), clearTimer = (id) => clearTimeout(id) }) {
  /** @type {Map<string, SearchResult[]>} answers of this visit, by source and words */
  const remembered = new Map();
  /** @type {any} the pause before asking */
  let pauseTimer = null;
  /** The number of the current run; a callback of an older run is ignored. */
  let runNumber = 0;
  /** @type {AbortController[]} the requests of the current run */
  let controllers = [];
  /** @type {any[]} the timeouts of those requests */
  let timeouts = [];
  /** The current run. */
  let current = { query: "", answers: /** @type {Map<string, SearchResult[]>} */ (new Map()), failures: /** @type {Map<string, string>} */ (new Map()), pending: /** @type {Set<string>} */ (new Set()), offline: false, active: false };

  const keyOf = (/** @type {string} */ sourceId, /** @type {string} */ words) => `${sourceId}\n${words}`;

  function emit() {
    onChange({
      query: current.query,
      active: current.active,
      searching: current.pending.size > 0,
      offline: current.offline,
      pending: sources.filter((source) => current.pending.has(source.id)).map((source) => source.name),
      failed: sources.filter((source) => current.failures.has(source.id)).map((source) => ({ id: source.id, name: source.name, reason: /** @type {string} */ (current.failures.get(source.id)) })),
      results: sources.flatMap((source) => current.answers.get(source.id) ?? []),
    });
  }

  function abortAll() {
    runNumber += 1;
    for (const controller of controllers) controller.abort();
    for (const timeout of timeouts) clearTimer(timeout);
    controllers = [];
    timeouts = [];
  }

  /**
   * Ask these sources for the words of the current run.
   *
   * @param {OnlineSource[]} asked
   */
  function ask(asked) {
    const number = runNumber;
    const words = wordsOf(current.query);
    for (const source of asked) {
      const known = source.instant ? source.instant(current.query) : remembered.get(keyOf(source.id, words));
      if (known) {
        current.answers.set(source.id, known);
        continue;
      }
      const controller = new AbortController();
      controllers.push(controller);
      current.pending.add(source.id);
      current.failures.delete(source.id);
      /** @param {() => void} change */
      const settle = (change) => {
        if (number !== runNumber || !current.pending.has(source.id)) return;
        clearTimer(timer);
        current.pending.delete(source.id);
        change();
        emit();
      };
      const timer = setTimer(() => {
        controller.abort();
        settle(() => current.failures.set(source.id, "took too long to answer"));
      }, TIMEOUT_MS);
      timeouts.push(timer);
      source.run(current.query, { signal: controller.signal }).then(
        (results) =>
          settle(() => {
            remembered.set(keyOf(source.id, words), results);
            current.answers.set(source.id, results);
          }),
        (error) => settle(() => current.failures.set(source.id, error instanceof Error ? error.message : String(error))),
      );
    }
  }

  /** @param {string} text */
  function begin(text) {
    abortAll();
    const query = text.trim();
    current = { query, answers: new Map(), failures: new Map(), pending: new Set(), offline: false, active: true };
    if (!isOnline()) {
      current.offline = true;
      emit();
      return;
    }
    ask(sources);
    emit();
  }

  return {
    query(text) {
      clearTimer(pauseTimer);
      pauseTimer = null;
      abortAll(); // the old words are no longer wanted, whatever the new ones are
      if (text.trim().length < MIN_QUERY_LENGTH) {
        current = { query: text.trim(), answers: new Map(), failures: new Map(), pending: new Set(), offline: false, active: false };
        emit();
        return;
      }
      pauseTimer = setTimer(() => {
        pauseTimer = null;
        begin(text);
      }, DEBOUNCE_MS);
    },
    retry() {
      if (!current.active || current.offline) {
        if (current.active && current.offline && isOnline()) begin(current.query);
        return;
      }
      const failed = sources.filter((source) => current.failures.has(source.id));
      if (failed.length === 0) return;
      ask(failed);
      emit();
    },
    cancel() {
      clearTimer(pauseTimer);
      pauseTimer = null;
      abortAll();
      current = { query: "", answers: new Map(), failures: new Map(), pending: new Set(), offline: false, active: false };
      emit();
    },
  };
}
