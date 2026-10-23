// @ts-check
// The light and dark themes.
//
// The app's own look is dark: a navy ground under glass cards, like a record shop at night. The
// light theme is the same layout in warm beige, like the plastic of a 90s console. Every color
// of the page is a CSS custom property (style.css), and `theme.css` redefines those under
// `:root[data-theme="light"]`; this module only sets that attribute on `<html>`.
//
// Which theme the page starts in:
// 1. the one the visitor chose last time with the button, kept in this browser (`THEME_KEY`);
// 2. else the one their system prefers (`prefers-color-scheme`);
// 3. else dark.
// Following the system is not a choice, so nothing is stored until the button is pressed.
//
// A page that sets the attribute from an inline script in `<head>` (so the first paint is already
// right) and then loads this module gets the same answer from both, because the script applies
// the same three rules.
//
// Canvases that read their colors from the custom properties (the evolution chart) need to draw
// again after a switch: `document` gets a `themechange` event whose `detail.theme` is the new one.

/** The localStorage key that holds the visitor's choice, "light" or "dark". */
export const THEME_KEY = "nes-arranger-theme";

/** The browser bar's color in each theme: the page's ground (`<meta name="theme-color">`). */
export const THEME_COLORS = Object.freeze({ dark: "#0B0E17", light: "#EDE6D6" });

/** @typedef {"light" | "dark"} Theme */

/**
 * The theme a page starts in.
 *
 * @param {string | null | undefined} stored what the visitor's browser kept, if anything
 * @param {boolean} prefersLight whether the system asks for a light page
 * @returns {Theme}
 * @example
 * initialTheme("dark", true); // "dark": the visitor's own choice wins
 * initialTheme(null, true); // "light": the system asks for it
 * initialTheme("sepia", false); // "dark": not a theme, so ignored
 */
export function initialTheme(stored, prefersLight) {
  if (stored === "light" || stored === "dark") return stored;
  return prefersLight ? "light" : "dark";
}

// Sun and moon, drawn with strokes in the text color. Inline, so nothing is fetched and the icon
// follows the button's color in both themes.
const ICONS = Object.freeze({
  sun:
    '<svg data-icon="sun" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4.2"/>' +
    '<path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.3 5.3l1.7 1.7M17 17l1.7 1.7M5.3 18.7 7 17M17 7l1.7-1.7"/></svg>',
  moon:
    '<svg data-icon="moon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    '<path d="M20.2 14.6A8.4 8.4 0 0 1 9.4 3.8a8.4 8.4 0 1 0 10.8 10.8Z"/></svg>',
});

/**
 * @typedef {object} ThemeToggle
 * @property {() => Theme} current the theme the page shows now
 * @property {(theme: Theme) => void} set show a theme without remembering it as the visitor's choice
 */

/**
 * Wire the header's theme button: show the starting theme, and flip it on each press.
 *
 * The button is a toggle: its name stays "Light theme" and `aria-pressed` says whether the light
 * theme is on, because a name that changes with the state would be read as a second button. Its
 * icon shows the theme on screen (a sun in the light theme, a moon in the dark one) and its
 * tooltip says what a press does.
 *
 * @param {HTMLElement} button
 * @param {Pick<Storage, "getItem" | "setItem">} storage where the choice is kept; may throw (a
 *   private window or blocked site data), which is then ignored
 * @param {object} [options]
 * @param {HTMLElement} [options.root] the element that carries `data-theme` (default `<html>`)
 * @param {Element | null} [options.meta] the `<meta name="theme-color">` to keep in step
 * @param {boolean} [options.prefersLight] the system's preference (default: asked from the browser)
 * @returns {ThemeToggle}
 * @example
 * const theme = setUpThemeToggle(document.querySelector("[data-theme-toggle]"), localStorage);
 * theme.current(); // "dark"
 */
export function setUpThemeToggle(button, storage, options = {}) {
  const doc = button.ownerDocument;
  const root = options.root ?? doc.documentElement;
  const meta = options.meta === undefined ? (doc.querySelector?.('meta[name="theme-color"]') ?? null) : options.meta;
  const prefersLight = options.prefersLight ?? globalThis.matchMedia?.("(prefers-color-scheme: light)")?.matches ?? false;

  /** @type {string | null} */
  let stored = null;
  try {
    stored = storage.getItem(THEME_KEY);
  } catch {
    // Blocked storage: the system's preference decides, and a choice lasts for this visit only.
  }
  /** @type {Theme} */
  let theme = initialTheme(stored, prefersLight);

  /** @param {Theme} next */
  function show(next) {
    theme = next;
    root.setAttribute("data-theme", next);
    meta?.setAttribute("content", THEME_COLORS[next]);
    button.setAttribute("aria-pressed", String(next === "light"));
    button.setAttribute("title", next === "light" ? "Switch to the dark theme" : "Switch to the light theme");
    // The icon shows the theme that is on.
    button.innerHTML = ICONS[next === "light" ? "sun" : "moon"];
    doc.dispatchEvent?.(new CustomEvent("themechange", { detail: { theme: next } }));
  }

  button.setAttribute("aria-label", "Light theme");
  show(theme);
  button.addEventListener("click", () => {
    show(theme === "light" ? "dark" : "light");
    try {
      storage.setItem(THEME_KEY, theme);
    } catch {
      // Not remembered, but the page has changed.
    }
  });

  return { current: () => theme, set: show };
}
