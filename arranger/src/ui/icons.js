// @ts-check
/**
 * Icons: small inline SVG drawings for the page's buttons.
 *
 * The page's retro objects are the ones of the era the chip comes from: a cassette for the WAV (the
 * recording you play), a floppy disk for the MIDI (the data you save), a game cartridge for the
 * settings file (the run you can load again) and a sheet of music for the lead sheet. They are line
 * drawings with square ends, in `currentColor`, so they follow the button's text color and the
 * theme; they are `aria-hidden` because the label next to them says the same in words. No emoji.
 */

/** The shapes of each icon, in a 24 × 24 box. */
export const ICONS = Object.freeze({
  cassette:
    '<rect x="2.5" y="5.5" width="19" height="13" rx="1.5"/><rect x="6" y="8" width="12" height="5" rx=".8"/>' +
    '<circle cx="9.2" cy="10.5" r="1.3"/><circle cx="14.8" cy="10.5" r="1.3"/><path d="M7.5 18.5l1.4-3h6.2l1.4 3"/>',
  floppy:
    '<path d="M4.5 3.5h12.6l2.9 2.9v14.1h-15.5z"/><rect x="8" y="3.5" width="7" height="5"/>' +
    '<path d="M12.7 4.8v2.4"/><rect x="7" y="13" width="10" height="7.5"/><path d="M9.2 15.6h5.6M9.2 17.8h5.6"/>',
  cartridge:
    '<path d="M6 3.5h12v14.2l-1.6 2.8H7.6L6 17.7z"/><rect x="8.2" y="6" width="7.6" height="5.2"/>' +
    '<path d="M9.2 20.5v-2.2h5.6v2.2M10 14h4"/>',
  sheet:
    '<path d="M6 3.5h8.6l3.9 3.9v13.1H6z"/><path d="M14.5 3.5v4h4"/><path d="M9 12h6.5M9 15h6.5M9 18h6.5"/>',
});

/**
 * An icon as markup.
 *
 * @param {string} name a key of `ICONS`
 * @returns {string} an `<svg>` string, or "" for an unknown name
 * @example
 * button.innerHTML = `${iconMarkup("floppy")}<span>MIDI</span>`;
 */
export function iconMarkup(name) {
  const shapes = /** @type {Record<string, string>} */ (ICONS)[name];
  if (!shapes) return "";
  return (
    `<svg class="icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" ` +
    `stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true" focusable="false">${shapes}</svg>`
  );
}

/**
 * The icon of a download by its file name.
 *
 * @param {string} fileName
 * @returns {"cassette" | "floppy" | "cartridge" | "sheet"}
 * @example
 * downloadIcon("run.wav"); // "cassette"
 */
export function downloadIcon(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".wav")) return "cassette";
  if (lower.endsWith(".mid") || lower.endsWith(".midi")) return "floppy";
  if (lower.endsWith(".json")) return "cartridge";
  return "sheet";
}
