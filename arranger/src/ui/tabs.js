// @ts-check
/**
 * Page tabs: the page shows one screen at a time, in the order of a run (spec 005, story 7).
 *
 * Song holds the catalog and the run controls. Evolution holds the run controls too, on top, and
 * under them two views of the run, each with the full width: the GA at work ("Evolution") and
 * what it found ("Result"). A second row of tabs switches between the two, so a setting can be
 * changed and the next run heard without leaving the tab. A run that starts shows the Evolution
 * view; one that ends shows the Result view (`main.js` calls `showView`).
 * The settings drawer and the mixer drawer (from the left edge) belong to the tabs that use them.
 * How it works explains the method. The settings drawer opens from the Song and Evolution tabs.
 * The chosen tab lives in the URL hash (`#song`, `#evolution`, `#how`), and on the Evolution tab
 * so does the chosen view (`#evolution`, `#result`), so a reload or a shared link opens the same
 * screen. An old link to a card (`#run`, `#about`) opens the tab that holds it now.
 * The keyboard follows the WAI-ARIA tabs pattern on both rows: arrows move between tabs and
 * wrap, Home and End jump to the ends.
 *
 * The pure helpers decide which tab, which view and which key; `setUpPageTabs` only shows and
 * hides the sections.
 */

/**
 * @typedef {object} PageTab
 * @property {string} id the hash and the tab button's `data-tab`
 * @property {string} label what the tab says
 * @property {readonly string[]} panels ids of the sections the tab shows
 */

/** @type {readonly PageTab[]} */
export const TABS = Object.freeze([
  Object.freeze({ id: "song", label: "Song", panels: Object.freeze(["song", "settings"]) }),
  Object.freeze({ id: "evolution", label: "Run", panels: Object.freeze(["workbench", "settings", "mix"]) }),
  Object.freeze({ id: "how", label: "How it works", panels: Object.freeze(["how"]) }),
]);

/**
 * @typedef {object} EvolutionView
 * @property {string} id the hash, the view button's `data-view` and the id of the section it shows
 * @property {string} label what the view button says
 */

/** The two views of the Evolution tab, in the order of a run. @type {readonly EvolutionView[]} */
export const VIEWS = Object.freeze([
  Object.freeze({ id: "evolution", label: "Evolution" }),
  Object.freeze({ id: "result", label: "Result" }),
]);

/** Section ids from before the tabs or the merge of Result into Evolution, and the tab that holds them now. */
const OLD_PANELS = Object.freeze({ about: "how", run: "song", result: "evolution" });

/**
 * The tab that shows a section.
 *
 * @param {string} panelId a section id, for example "run"
 * @returns {string | null} the tab id, or null for an unknown section
 * @example
 * tabForPanel("settings"); // "song"
 */
export function tabForPanel(panelId) {
  const tab = TABS.find((candidate) => candidate.id === panelId || candidate.panels.includes(panelId));
  if (tab) return tab.id;
  return OLD_PANELS[/** @type {keyof typeof OLD_PANELS} */ (panelId)] ?? null;
}

/**
 * The tab a URL hash asks for; the Song tab when the hash names nothing known.
 *
 * @param {string} hash `location.hash`, with or without "#"
 * @returns {string} a tab id
 * @example
 * tabFromHash("#result"); // "result"
 * tabFromHash(""); // "song"
 */
export function tabFromHash(hash) {
  return tabForPanel(hash.replace(/^#/, "")) ?? TABS[0].id;
}

/**
 * What a URL hash asks for: a tab, and on the Evolution tab a view.
 *
 * `#result` is the Evolution tab on its Result view and `#evolution` (or the old `#workbench`) on
 * its Evolution view. A hash that names another tab, or only a drawer, names no view (`null`):
 * the view stays as it was.
 *
 * @param {string} hash `location.hash`, with or without "#"
 * @returns {{tab: string, view: string | null}}
 * @example
 * routeFromHash("#result"); // { tab: "evolution", view: "result" }
 * routeFromHash("#how"); // { tab: "how", view: null }
 */
export function routeFromHash(hash) {
  const name = hash.replace(/^#/, "");
  const tab = tabFromHash(name);
  if (VIEWS.some((view) => view.id === name)) return { tab, view: name };
  if (name === "workbench") return { tab, view: VIEWS[0].id };
  return { tab, view: null };
}

/**
 * The hash to show for a tab and view: the view's name on the Evolution tab, the tab's name
 * elsewhere (the view is then only remembered by the page).
 *
 * @param {string} tab a tab id
 * @param {string} view a view id
 * @returns {string} for example "#result"
 * @example
 * hashFor("evolution", "result"); // "#result"
 * hashFor("song", "result"); // "#song"
 */
export function hashFor(tab, view) {
  return `#${tab === "evolution" ? view : tab}`;
}

/**
 * The tab a key moves to, in the WAI-ARIA tabs pattern.
 *
 * @param {number} index the current tab's index
 * @param {string} key `KeyboardEvent.key`
 * @param {number} count the number of tabs
 * @returns {number | null} the new index, or null when the key does not move
 * @example
 * stepTab(3, "ArrowRight", 4); // 0, wrapping around
 */
export function stepTab(index, key, count) {
  if (key === "ArrowRight") return (index + 1) % count;
  if (key === "ArrowLeft") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/**
 * Wire the tab buttons in `nav` to the page sections, and the view buttons to the two views of
 * the Evolution tab.
 *
 * @param {HTMLElement} nav the element with `role="tablist"` and one `[data-tab]` button per tab
 * @param {{
 *   onChange?: (id: string) => void,
 *   viewNav?: HTMLElement | null,
 *   onViewChange?: (view: string) => void,
 * }} [options] `viewNav` holds one `[data-view]` button per view; `onChange` and `onViewChange`
 *   run after a tab or a view is shown
 * @returns {{
 *   show: (id: string, options?: {focus?: boolean}) => void,
 *   current: () => string,
 *   showView: (id: string, options?: {focus?: boolean}) => void,
 *   view: () => string,
 * }}
 */
export function setUpPageTabs(nav, options = {}) {
  const buttons = /** @type {HTMLButtonElement[]} */ ([...nav.querySelectorAll("[data-tab]")]);
  const viewButtons = /** @type {HTMLButtonElement[]} */ ([...(options.viewNav?.querySelectorAll("[data-view]") ?? [])]);
  let current = TABS[0].id;
  let view = VIEWS[0].id;

  function writeHash() {
    const hash = hashFor(current, view);
    if (location.hash !== hash) history.replaceState(null, "", hash);
  }

  function show(/** @type {string} */ id, { focus = false } = {}) {
    current = TABS.some((tab) => tab.id === id) ? id : TABS[0].id;
    // A section can belong to two tabs (the settings drawer): it shows when the chosen tab has it.
    const shown = new Set(TABS.find((tab) => tab.id === current)?.panels);
    for (const panelId of new Set(TABS.flatMap((tab) => tab.panels))) {
      const panel = document.getElementById(panelId);
      if (panel) panel.hidden = !shown.has(panelId);
    }
    for (const button of buttons) {
      const selected = button.dataset.tab === current;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected && focus) button.focus();
    }
    writeHash();
    options.onChange?.(current);
  }

  /** Show one view of the Evolution tab, even while another tab is open: it is there when the visitor returns. */
  function showView(/** @type {string} */ id, { focus = false } = {}) {
    view = VIEWS.some((candidate) => candidate.id === id) ? id : VIEWS[0].id;
    for (const candidate of VIEWS) {
      const panel = document.getElementById(candidate.id);
      if (panel) panel.hidden = candidate.id !== view;
    }
    for (const button of viewButtons) {
      const selected = button.dataset.view === view;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected && focus) button.focus();
    }
    writeHash();
    options.onViewChange?.(view);
  }

  buttons.forEach((button, index) => {
    button.addEventListener("click", () => show(/** @type {string} */ (button.dataset.tab)));
    button.addEventListener("keydown", (event) => {
      const next = stepTab(index, event.key, buttons.length);
      if (next === null) return;
      event.preventDefault();
      show(/** @type {string} */ (buttons[next].dataset.tab), { focus: true });
    });
  });
  viewButtons.forEach((button, index) => {
    button.addEventListener("click", () => showView(/** @type {string} */ (button.dataset.view)));
    button.addEventListener("keydown", (event) => {
      const next = stepTab(index, event.key, viewButtons.length);
      if (next === null) return;
      event.preventDefault();
      showView(/** @type {string} */ (viewButtons[next].dataset.view), { focus: true });
    });
  });
  /** @param {string} hash */
  function followHash(hash) {
    const route = routeFromHash(hash);
    if (route.view) showView(route.view);
    show(route.tab);
  }
  addEventListener("hashchange", () => followHash(location.hash));
  followHash(location.hash);
  return { show, current: () => current, showView, view: () => view };
}
