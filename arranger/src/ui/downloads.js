// @ts-check
/**
 * Downloads: the four files that keep a run (spec 002, FR-024 and FR-025).
 *
 * - `<run id>.mid`: the arrangement as a four-track MIDI file (P1, P2, TR, NO), with a floppy disk;
 * - `<run id>.config.json`: the run record, which the command line accepts with `--config`;
 * - `<run id>.wav`: the arrangement as it sounds, with a cassette;
 * - `<run id>.abc`: the lead sheet the run arranged, so a MIDI song can be rerun without its file.
 *
 * The files are made in the browser and saved by the browser; nothing is uploaded.
 *
 * Each link points at an object URL, and an object URL keeps its file in memory until the page
 * revokes it. The WAV is 17 MB for a three-minute song, so the rule is to hold no more URLs than
 * the page needs: a new set of files or a clear revokes the old ones, a second click on a file
 * made on demand revokes the first copy, and a copy made on a click is revoked a minute later,
 * long after the browser has begun saving it.
 *
 * Making a WAV (mixing four stems and encoding them) takes a fraction of a second on a desktop
 * and several times that on a phone, so a click on a made file is a small job with a visible
 * state: the link shows the spinning record and "Preparing…", the page gets two animation frames
 * to paint that before the work starts, and then the browser saves the file as if the visitor
 * had followed a link. A file with nothing to save (every channel muted) says so in a message.
 * Every link then shows a tick for a moment ("Saved"), so a click always has a visible answer.
 */

import { setBusy } from "./busy.js";
import { downloadIcon, iconMarkup } from "./icons.js";
import { notify } from "./notify.js";

/** How long a file made on a click stays available, in ms: the browser reads it at once. */
const MADE_FILE_LINGER_MS = 60_000;

/** How long the "Saved" tick stays on a link, in ms. */
const SAVED_MS = 1500;

/**
 * A file to offer: ready as a `blob`, or made when the visitor clicks, by `make` (for a file that
 * is costly to build and depends on settings that change, such as the mixed WAV). `make` returns
 * null when there is nothing to save, and then the click saves nothing and says `emptyMessage`.
 * @typedef {{
 *   name: string, label: string, hint: string, blob?: Blob, make?: () => Blob | null,
 *   sizeText?: string, busyLabel?: string, emptyMessage?: string
 * }} DownloadFile
 * `sizeText` is shown beside the file name ("about 9 MB").
 */

/**
 * A size for a person.
 *
 * @param {number} bytes
 * @returns {string} for example "about 17 MB"
 * @example
 * formatSize(17_640_044); // "about 17 MB"
 * formatSize(2300); // "about 2 KB"
 */
export function formatSize(bytes) {
  if (bytes >= 1_000_000) return `about ${Math.round(bytes / 1_000_000)} MB`;
  return `about ${Math.max(1, Math.round(bytes / 1000))} KB`;
}

/** Wait for two animation frames: long enough for the page to paint a state set just before. @returns {Promise<void>} */
function paintedFrames() {
  if (typeof requestAnimationFrame !== "function") return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

/**
 * Save a file the way a click on a link would.
 *
 * @param {string} url an object URL
 * @param {string} name the file name
 */
function saveFile(url, name) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

/**
 * Build the download buttons inside `container`.
 *
 * @param {HTMLElement} container
 * @param {{
 *   setTimer?: (run: () => void, delay: number) => any,
 *   clearTimer?: (id: any) => void,
 *   nextFrame?: () => Promise<void>,
 *   save?: (url: string, name: string) => void,
 *   notify?: (message: string, options?: {kind?: "info" | "error"}) => unknown,
 * }} [parts] the clock, the frame wait, the saving and the messages, replaced by the tests
 * @returns {{set: (files: DownloadFile[]) => void, clear: () => void}}
 */
export function createDownloads(
  container,
  { setTimer = setTimeout, clearTimer = clearTimeout, nextFrame = paintedFrames, save = saveFile, notify: say = notify } = {},
) {
  container.classList.add("downloads");
  /** @type {Set<string>} the object URLs alive now */
  const urls = new Set();
  /** @type {Set<any>} the pending releases of made files and the saved ticks */
  const releases = new Set();

  /** @param {string} url */
  function release(url) {
    URL.revokeObjectURL(url);
    urls.delete(url);
  }

  function clear() {
    for (const id of releases) clearTimer(id);
    releases.clear();
    ticks.clear();
    urls.forEach((url) => URL.revokeObjectURL(url));
    urls.clear();
    container.replaceChildren();
  }

  /** @type {Map<HTMLElement, any>} the timer that takes each link's tick away */
  const ticks = new Map();

  /** Show the "Saved" tick on a link for a moment; a new save starts the moment again. @param {HTMLElement} link */
  function showSaved(link) {
    link.classList.add("is-saved");
    const earlier = ticks.get(link);
    if (earlier !== undefined) {
      clearTimer(earlier);
      releases.delete(earlier);
    }
    const id = setTimer(() => {
      releases.delete(id);
      ticks.delete(link);
      link.classList.remove("is-saved");
    }, SAVED_MS);
    ticks.set(link, id);
    releases.add(id);
  }

  /** @param {DownloadFile} file */
  function makeLink(file) {
    const link = document.createElement("a");
    link.className = "button download";
    link.download = file.name;
    link.title = file.hint;
    const icon = document.createElement("span");
    icon.className = "dl-icon";
    icon.innerHTML = iconMarkup(downloadIcon(file.name));
    const text = document.createElement("span");
    text.className = "dl-text";
    const label = document.createElement("span");
    label.textContent = file.label;
    const detail = document.createElement("span");
    detail.className = "file mono";
    detail.textContent = file.sizeText ? `${file.name} · ${file.sizeText}` : file.name;
    text.append(label, detail);
    const saved = document.createElement("span");
    saved.className = "dl-saved";
    saved.textContent = "Saved";
    link.append(icon, text, saved);

    if (file.blob) {
      const url = URL.createObjectURL(file.blob);
      urls.add(url);
      link.href = url;
      // The browser follows the link itself; the tick only confirms it.
      link.addEventListener("click", () => showSaved(link));
    } else if (file.make) {
      const make = file.make;
      // The link has no address until it is used; a click makes the file and then saves it.
      link.href = "#";
      /** @type {string | null} the address of the file made by the last click */
      let made = null;
      /** @type {any} the pending release of that file */
      let pending = null;
      let working = false;
      link.addEventListener("click", async (event) => {
        event.preventDefault();
        if (working) return;
        working = true;
        setBusy(link, true, file.busyLabel ?? "Preparing…");
        try {
          await nextFrame();
          const blob = make();
          if (!blob) {
            say(file.emptyMessage ?? "There is nothing to save.");
            return;
          }
          // One file per link at a time: the earlier click's copy has been saved by now.
          if (made) release(made);
          if (pending !== null) {
            clearTimer(pending);
            releases.delete(pending);
          }
          const url = URL.createObjectURL(blob);
          made = url;
          urls.add(url);
          save(url, file.name);
          pending = setTimer(() => {
            releases.delete(pending);
            pending = null;
            made = null;
            release(url);
          }, MADE_FILE_LINGER_MS);
          releases.add(pending);
          setBusy(link, false);
          showSaved(link);
        } catch (error) {
          say(`${file.label} could not be made: ${error instanceof Error ? error.message : String(error)}`, { kind: "error" });
        } finally {
          working = false;
          setBusy(link, false);
        }
      });
    }
    return link;
  }

  return {
    set(files) {
      clear();
      for (const file of files) container.append(makeLink(file));
    },
    clear,
  };
}
