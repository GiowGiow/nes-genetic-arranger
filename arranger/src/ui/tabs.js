// @ts-check
/**
 * Page tabs: the page shows one screen at a time, in the order of a run (spec 005, story 7).
 *
 * Song holds the catalog and the run controls. Evolution holds the run controls too, the GA at
 * work and the result, so that a setting can be changed and the next run heard on one screen.
 * How it works explains the method. The settings drawer opens from the Song and Evolution tabs.
 * The chosen tab lives in the URL hash (`#song`, `#evolution`, `#how`), so a reload or a shared
 * link opens the same screen. An old link to a card (`#run`, `#result`, `#about`) opens the tab
 * that holds it now.
 * The keyboard follows the WAI-ARIA tabs pattern: arrows move between tabs and wrap, Home and
 * End jump to the ends.
 *
 * The pure helpers decide which tab and which key; `setUpPageTabs` only shows and hides the
 * sections.
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
  Object.freeze({ id: "evolution", label: "Evolution", panels: Object.freeze(["evolution", "result", "settings"]) }),
  Object.freeze({ id: "how", label: "How it works", panels: Object.freeze(["how"]) }),
]);

/** Section ids from before the tabs or the merge of Result into Evolution, and the tab that holds them now. */
const OLD_PANELS = Object.freeze({ about: "how", run: "song" });

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
 * Wire the tab buttons in `nav` to the page sections.
 *
 * @param {HTMLElement} nav the element with `role="tablist"` and one `[data-tab]` button per tab
 * @param {{onChange?: (id: string) => void}} [options]
 * @returns {{show: (id: string, options?: {focus?: boolean}) => void, current: () => string}}
 */
export function setUpPageTabs(nav, options = {}) {
  const buttons = /** @type {HTMLButtonElement[]} */ ([...nav.querySelectorAll("[data-tab]")]);
  let current = TABS[0].id;

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
    if (location.hash !== `#${current}`) history.replaceState(null, "", `#${current}`);
    options.onChange?.(current);
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
  addEventListener("hashchange", () => show(tabFromHash(location.hash)));
  show(tabFromHash(location.hash));
  return { show, current: () => current };
}
