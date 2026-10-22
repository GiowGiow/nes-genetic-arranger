// @ts-check
/**
 * Downloaded file: how the page asks for a song the visitor downloaded by hand.
 *
 * Some songs (the MPB catalog) live at a site that sends no CORS header, so the page cannot fetch
 * their MIDI file. The visitor downloads it in the browser's own way and then gives it to the
 * page. A page can never read the Downloads folder by itself (browsers forbid it), so the
 * visitor always confirms the file in a dialog; the page can only make that dialog start in the
 * right folder.
 *
 * - Chrome and Edge have `showOpenFilePicker`, which accepts `startIn: "downloads"`: the dialog
 *   opens on the file the visitor just saved.
 * - Firefox and Safari have only the ordinary `<input type="file">`, which opens where the
 *   browser remembers.
 *
 * `pickerKind` is the decision, a pure function of the window; `openDownloadedFile` acts on it.
 */

/**
 * What the native picker is asked for: one MIDI or ABC file, starting in Downloads.
 * @type {Readonly<{startIn: string, multiple: boolean, types: Array<{description: string, accept: Record<string, string[]>}>}>}
 * @example
 * await window.showOpenFilePicker(DOWNLOAD_PICKER_OPTIONS); // opens the Downloads folder
 */
export const DOWNLOAD_PICKER_OPTIONS = Object.freeze({
  startIn: "downloads",
  multiple: false,
  types: [{ description: "MIDI or ABC", accept: { "audio/midi": [".mid", ".midi"], "text/plain": [".abc"] } }],
});

/**
 * Which dialog the browser can open in the Downloads folder.
 *
 * @param {{showOpenFilePicker?: unknown} | undefined} win the window (or a stand-in in the tests)
 * @returns {"native" | "input"} "native" when `showOpenFilePicker` exists, else "input" (the
 *   hidden file input, which every browser has)
 * @example
 * pickerKind(window); // "native" in Chrome and Edge, "input" in Firefox and Safari
 */
export function pickerKind(win) {
  return typeof win?.showOpenFilePicker === "function" ? "native" : "input";
}

/**
 * Open the dialog for the downloaded file.
 *
 * With the native picker, the chosen file goes to `onFile`. With the file input, the click opens
 * the dialog and the input panel's own `change` listener reads the file, so `onFile` is not
 * called. A visitor who cancels the native dialog ends the call quietly, and a native picker that
 * fails for any other reason falls back to the file input.
 *
 * @param {{
 *   win: {showOpenFilePicker?: unknown} | undefined,
 *   fileInput: {click: () => void},
 *   onFile: (file: File) => unknown,
 * }} options
 * @returns {Promise<"picker" | "input" | "cancelled">} how the file was asked for: "picker" (given
 *   to `onFile`), "input" (the input was opened) or "cancelled" (nothing chosen)
 * @example
 * await openDownloadedFile({ win: window, fileInput, onFile: (file) => inputPanel.readFile(file) });
 */
export async function openDownloadedFile({ win, fileInput, onFile }) {
  if (pickerKind(win) === "native") {
    try {
      const picker = /** @type {(options: object) => Promise<Array<{getFile: () => Promise<File>}>>} */ (
        /** @type {any} */ (win).showOpenFilePicker
      );
      const [handle] = await picker.call(win, DOWNLOAD_PICKER_OPTIONS);
      if (!handle) return "cancelled";
      await onFile(await handle.getFile());
      return "picker";
    } catch (error) {
      if (/** @type {Error} */ (error)?.name === "AbortError") return "cancelled";
      // Blocked or unsupported options: the ordinary input still works.
    }
  }
  fileInput.click();
  return "input";
}

/**
 * Whether a file name is the download it was waiting for. Browsers keep the name but may change
 * its case, add " (1)" before the extension when a file of that name exists, or leave the other
 * MIDI extension.
 *
 * @param {string} name the chosen file's name
 * @param {string} expected the name the page gave the download
 * @returns {boolean}
 * @example
 * looksLikeDownload("Aquarela (1).mid", "Aquarela.mid"); // true
 * looksLikeDownload("Other.mid", "Aquarela.mid"); // false
 */
export function looksLikeDownload(name, expected) {
  const base = (/** @type {string} */ file) =>
    file
      .replace(/\.[^.]*$/, "")
      .replace(/ \(\d+\)$/, "")
      .normalize("NFC")
      .toLowerCase();
  return base(name) === base(expected);
}

/**
 * What the page says once a song's file starts downloading: where to find it next.
 *
 * @param {string} name the name the file is saved under
 * @param {{showOpenFilePicker?: unknown} | undefined} win the window, to know which dialog opens
 * @returns {string}
 * @example
 * downloadStartedMessage("Aquarela.mid", window);
 * // "Downloading Aquarela.mid. When it finishes, press Open downloaded file: the dialog opens in your Downloads folder."
 */
export function downloadStartedMessage(name, win) {
  const where =
    pickerKind(win) === "native"
      ? "the dialog opens in your Downloads folder"
      : `choose ${name} in the dialog`;
  return `Downloading ${name}. When it finishes, press Open downloaded file: ${where}.`;
}
