// @ts-check
// The two drawers: Settings (from the right edge) and the mixer (from the left edge).
//
// Both slide in over the page without moving it, so the evolution or the result keeps its place
// while a value changes or a channel level moves (drawers.css and mixer.css draw them). This
// module is their behavior:
// - A button opens and closes each, and says so with `aria-expanded`.
// - Settings takes the focus when it opens and gives it back to its button when it closes (only
//   if the focus was inside, so a click elsewhere is not undone). Escape inside it closes it.
// - The mixer opens by itself when music starts on a wide screen, where it covers nothing the
//   visitor needs, unless they closed it by hand: a drawer closed on purpose stays closed.
//
// It takes its elements as parameters so the tests can run it on a fake page.

/** The width from which the mixer may open by itself (it is a sheet over the page below this). */
export const WIDE_QUERY = "(min-width: 1100px)";

/**
 * @typedef {object} DrawerParts
 * @property {HTMLElement} settings the Settings drawer (`#settings`)
 * @property {HTMLElement} settingsTitle its heading, which takes the focus on opening
 * @property {HTMLElement} settingsToggle the button that opens and closes it
 * @property {HTMLElement} settingsClose its Close button
 * @property {HTMLElement} mix the mixer drawer (`#mix`)
 * @property {HTMLElement} mixToggle the Mix button
 * @property {HTMLElement} mixClose the mixer's Close button
 * @property {Document} [document] where the focus is read (default the page)
 * @property {() => boolean} [isWide] true on a screen where the mixer may open by itself
 *   (default: the media query `WIDE_QUERY`)
 */

/**
 * @typedef {object} Drawers
 * @property {(open?: boolean) => void} toggleSettings open (true), close (false) or flip (no argument) the Settings drawer
 * @property {() => boolean} isSettingsOpen
 * @property {(open: boolean, byHand?: boolean) => void} setMixDrawer open or close the mixer; `byHand` says the visitor did it
 * @property {() => void} autoOpenMix open the mixer because music started, if the screen is wide and the visitor did not close it
 * @property {() => boolean} isMixOpen
 */

/**
 * Wire the two drawers' buttons and keys.
 *
 * @param {DrawerParts} parts
 * @returns {Drawers}
 * @example
 * const drawers = setUpDrawers({ settings, settingsTitle, settingsToggle, settingsClose, mix, mixToggle, mixClose });
 * drawers.toggleSettings(true); // the Settings drawer slides in and takes the focus
 */
export function setUpDrawers(parts) {
  const { settings, settingsTitle, settingsToggle, settingsClose, mix, mixToggle, mixClose } = parts;
  const doc = parts.document ?? document;
  const isWide = parts.isWide ?? (() => globalThis.matchMedia?.(WIDE_QUERY).matches ?? false);
  let mixClosedByHand = false;

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
    // preventScroll: the drawer is fixed, and the page behind it must not jump to its element
    if (show) settingsTitle.focus({ preventScroll: true });
    else if (settings.contains(doc.activeElement)) settingsToggle.focus();
  }

  /**
   * @param {boolean} open
   * @param {boolean} [byHand] the visitor did it, so playing must not open the drawer again
   */
  function setMixDrawer(open, byHand = false) {
    mix.classList.toggle("open", open);
    mixToggle.setAttribute("aria-expanded", String(open));
    if (byHand) mixClosedByHand = !open;
  }

  settingsToggle.addEventListener("click", () => toggleSettings());
  settingsClose.addEventListener("click", () => toggleSettings(false));
  settings.addEventListener("keydown", (event) => {
    if (/** @type {KeyboardEvent} */ (event).key === "Escape") toggleSettings(false);
  });
  mixToggle.addEventListener("click", () => setMixDrawer(!mix.classList.contains("open"), true));
  mixClose.addEventListener("click", () => setMixDrawer(false, true));

  return {
    toggleSettings,
    isSettingsOpen: () => settings.classList.contains("open"),
    setMixDrawer,
    autoOpenMix() {
      if (!mixClosedByHand && isWide()) setMixDrawer(true);
    },
    isMixOpen: () => mix.classList.contains("open"),
  };
}
