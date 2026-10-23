// @ts-check
// The two drawers: Settings (from the right edge) and the mixer (from the left edge).
//
// Both slide in over the page without moving it, so the evolution or the result keeps its place
// while a value changes or a channel level moves (drawers.css and mixer.css draw them). This
// module is their behavior.
//
// Settings is modal, like a dialog: while it is open a scrim dims the page, everything else on
// the page is `inert` (it cannot be clicked, tabbed to or read by a screen reader), Tab cycles
// inside the drawer, and a click on the scrim or Escape closes it. Focus moves in when it opens
// and returns to its button when it closes, but only if it was inside, so a click elsewhere is not
// undone.
//
// The mixer is modal only where it is a sheet over the page (a narrow screen). On a wide screen
// it sits at the left edge beside the player, and the visitor needs Play and the position bar
// while moving the faders, so there it has no scrim, leaves the page live, and Escape closes it
// only when the focus is inside it.
//
// The mixer never opens by itself. It used to open when music started, which covered the page
// without being asked; now the first play only makes the Mix button pulse once (`hintMix`).
//
// It takes its elements as parameters so the tests can run it on a fake page.

/** The width from which the mixer sits beside the page instead of over it (mixer.css). */
export const WIDE_QUERY = "(min-width: 1100px)";

/** What Tab can reach inside a drawer. */
const FOCUSABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';

/** Tags that are never part of what the visitor sees, so they need no `inert`. */
const NOT_VISIBLE = new Set(["SCRIPT", "STYLE", "LINK", "TEMPLATE", "NOSCRIPT"]);

/**
 * @typedef {object} DrawerParts
 * @property {HTMLElement} settings the Settings drawer (`#settings`)
 * @property {HTMLElement} settingsTitle its heading, which takes the focus on opening
 * @property {HTMLElement} settingsToggle the button that opens and closes it
 * @property {HTMLElement} settingsClose its Close button
 * @property {HTMLElement} mix the mixer drawer (`#mix`)
 * @property {HTMLElement} mixToggle the Mix button
 * @property {HTMLElement} mixClose the mixer's Close button
 * @property {HTMLElement} [scrim] the dimmed layer behind a modal drawer (default: a new `div.scrim`
 *   at the end of the body)
 * @property {Document} [document] where the focus is read (default the page)
 * @property {() => boolean} [isWide] true on a screen where the mixer sits beside the page
 *   (default: the media query `WIDE_QUERY`)
 * @property {(root: HTMLElement) => HTMLElement[]} [focusables] what Tab can reach inside a drawer,
 *   in order (default: the visible links, buttons and fields)
 * @property {(open: boolean) => void} [onMixChange] called after the mixer opens or closes
 */

/**
 * @typedef {object} Drawers
 * @property {(open?: boolean) => void} toggleSettings open (true), close (false) or flip (no argument) the Settings drawer
 * @property {() => boolean} isSettingsOpen
 * @property {(open: boolean, byHand?: boolean) => void} setMixDrawer open or close the mixer; `byHand` says the visitor did it
 * @property {() => void} hintMix make the Mix button pulse once, the first time music plays
 * @property {() => void} autoOpenMix the old name of `hintMix`, kept for a page that still calls it; it no longer opens anything
 * @property {() => boolean} isMixOpen
 */

/**
 * What sits next to a drawer on its way up to the body: the parts of the page behind it. Setting
 * these `inert` makes the page unreachable while the drawer is open, and leaves the drawer and
 * everything that holds it (the `main`) live.
 *
 * @param {HTMLElement} drawer
 * @param {(element: HTMLElement) => boolean} [keep] elements to leave out, such as the scrim and the toasts
 * @returns {HTMLElement[]}
 * @example
 * // <body><div class="toast-region"></div><main><header></header><aside id="mix"></aside></main></body>
 * backgroundOf(mix, (element) => element.classList.contains("toast-region")); // [header]
 */
export function backgroundOf(drawer, keep = () => false) {
  /** @type {HTMLElement[]} */
  const background = [];
  for (let path = drawer; path.parentElement; path = path.parentElement) {
    for (const sibling of /** @type {HTMLElement[]} */ ([...path.parentElement.children])) {
      if (sibling !== path && !keep(sibling) && !NOT_VISIBLE.has(sibling.tagName)) background.push(sibling);
    }
  }
  return background;
}

/**
 * Wire the two drawers' buttons and keys.
 *
 * @param {DrawerParts} parts
 * @returns {Drawers}
 * @example
 * const drawers = setUpDrawers({ settings, settingsTitle, settingsToggle, settingsClose, mix, mixToggle, mixClose });
 * drawers.toggleSettings(true); // the Settings drawer slides in, the page is dimmed and inert, and the focus moves in
 */
export function setUpDrawers(parts) {
  const { settings, settingsTitle, settingsToggle, settingsClose, mix, mixToggle, mixClose, onMixChange = () => {} } = parts;
  const doc = parts.document ?? document;
  const isWide = parts.isWide ?? (() => globalThis.matchMedia?.(WIDE_QUERY).matches ?? false);
  const focusables =
    parts.focusables ?? ((root) => /** @type {HTMLElement[]} */ ([...root.querySelectorAll(FOCUSABLE)]).filter((element) => !element.closest("[hidden]")));
  const scrim = parts.scrim ?? makeScrim(doc);
  scrim.hidden = false; // the markup may start it hidden; the class `open` shows it
  mix.setAttribute("tabindex", "-1"); // so the drawer itself can take the focus, like the settings title
  let mixHinted = false;
  /** @type {HTMLElement[]} the parts of the page made inert for the open drawer */
  let inerted = [];

  /** The drawer that holds the visitor now, or null when the page is live. */
  function modalDrawer() {
    if (settings.classList.contains("open")) return settings;
    if (mix.classList.contains("open") && !isWide()) return mix;
    return null;
  }

  /** Show the scrim and make the page inert for the modal drawer, or give the page back. */
  function syncModal() {
    for (const element of inerted) /** @type {any} */ (element).inert = false;
    inerted = [];
    const drawer = modalDrawer();
    scrim.classList.toggle("open", drawer !== null);
    if (drawer === null) return;
    inerted = backgroundOf(drawer, (element) => element === scrim || element.classList.contains("toast-region"));
    for (const element of inerted) /** @type {any} */ (element).inert = true;
  }

  /**
   * Open (true), close (false) or flip (undefined) the Settings drawer. Focus moves into the
   * drawer on opening and back to its button on closing.
   *
   * @param {boolean} [open]
   */
  function toggleSettings(open) {
    const isOpen = settings.classList.contains("open");
    const show = open ?? !isOpen;
    if (show === isOpen) return;
    settings.classList.toggle("open", show);
    settingsToggle.setAttribute("aria-expanded", String(show));
    settingsToggle.textContent = show ? "Hide settings" : "Settings";
    // The page is live again before the focus goes back: an inert button cannot take it.
    syncModal();
    // preventScroll: the drawer is fixed, and the page behind it must not jump to its element
    if (show) settingsTitle.focus({ preventScroll: true });
    else if (settings.contains(doc.activeElement)) settingsToggle.focus();
  }

  /**
   * @param {boolean} open
   * @param {boolean} [byHand] the visitor did it: the focus follows
   */
  function setMixDrawer(open, byHand = false) {
    const wasOpen = mix.classList.contains("open");
    mix.classList.toggle("open", open);
    mixToggle.setAttribute("aria-expanded", String(open));
    syncModal();
    if (byHand) {
      mixToggle.classList.remove("nudge");
      if (open) mix.focus({ preventScroll: true });
      else if (mix.contains(doc.activeElement)) mixToggle.focus();
    }
    if (open !== wasOpen) onMixChange(open);
  }

  /** Close the drawer that holds the visitor, if any: the one a click on the scrim or Escape means. */
  function closeModal() {
    const drawer = modalDrawer();
    if (drawer === settings) toggleSettings(false);
    else if (drawer === mix) setMixDrawer(false, true);
  }

  /** @param {KeyboardEvent} event */
  function onKey(event) {
    if (event.key === "Escape") {
      // A wide mixer is not modal: Escape reaches it only from inside, not from the player's controls.
      if (modalDrawer() !== null) closeModal();
      else if (mix.classList.contains("open") && mix.contains(doc.activeElement)) setMixDrawer(false, true);
    } else if (event.key === "Tab") {
      keepFocusInside(event);
    }
  }

  /** @param {KeyboardEvent} event */
  function keepFocusInside(event) {
    const drawer = modalDrawer();
    if (drawer === null) return;
    const items = focusables(drawer);
    const active = /** @type {HTMLElement | null} */ (doc.activeElement);
    const position = active ? items.indexOf(active) : -1;
    if (items.length === 0) {
      event.preventDefault();
    } else if (event.shiftKey && position <= 0) {
      // From the first control, or from the drawer's own title, backwards: to the last control.
      items[items.length - 1].focus();
      event.preventDefault();
    } else if (!event.shiftKey && position === items.length - 1) {
      items[0].focus();
      event.preventDefault();
    }
  }

  settingsToggle.addEventListener("click", () => toggleSettings());
  settingsClose.addEventListener("click", () => toggleSettings(false));
  mixToggle.addEventListener("click", () => setMixDrawer(!mix.classList.contains("open"), true));
  mixClose.addEventListener("click", () => setMixDrawer(false, true));
  scrim.addEventListener("click", closeModal);
  doc.addEventListener("keydown", (event) => onKey(/** @type {KeyboardEvent} */ (event)));
  mixToggle.addEventListener("animationend", () => mixToggle.classList.remove("nudge"));
  // Resizing across the wide breakpoint turns the mixer into a sheet or back: the scrim follows.
  globalThis.matchMedia?.(WIDE_QUERY)?.addEventListener?.("change", syncModal);

  /** Make the Mix button pulse once per visit, unless the mixer is open already. */
  function hintMix() {
    if (mixHinted || mix.classList.contains("open")) return;
    mixHinted = true;
    mixToggle.classList.add("nudge");
  }

  return {
    toggleSettings,
    isSettingsOpen: () => settings.classList.contains("open"),
    setMixDrawer,
    hintMix,
    autoOpenMix: hintMix,
    isMixOpen: () => mix.classList.contains("open"),
  };
}

/**
 * The dimmed layer behind a modal drawer, added to the end of the body.
 * @param {Document} doc
 * @returns {HTMLElement}
 */
function makeScrim(doc) {
  const scrim = doc.createElement("div");
  scrim.className = "scrim";
  scrim.setAttribute("aria-hidden", "true");
  doc.body?.append(scrim);
  return scrim;
}
