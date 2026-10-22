// @ts-check
/**
 * Downloads: the three files that keep a run (spec 002, FR-024 and FR-025).
 *
 * - `<run id>.mid`: the arrangement as a four-track MIDI file (P1, P2, TR, NO);
 * - `<run id>.config.json`: the run record, which the command line accepts with `--config`;
 * - `<run id>.abc`: the lead sheet the run arranged, so a MIDI song can be rerun without its file.
 *
 * The files are made in the browser and saved by the browser; nothing is uploaded.
 *
 * Each link points at an object URL, and an object URL keeps its file in memory until the page
 * revokes it. The WAV is 17 MB for a three-minute song, so the rule is to hold no more URLs than
 * the page needs: a new set of files or a clear revokes the old ones, a second click on a file
 * made on demand revokes the first copy, and a copy made on a click is revoked a minute later,
 * long after the browser has begun saving it.
 */

/** How long a file made on a click stays available, in ms: the browser reads it at once. */
const MADE_FILE_LINGER_MS = 60_000;

/**
 * A file to offer: ready as a `blob`, or made when the visitor clicks, by `make` (for a file that
 * is costly to build and depends on settings that change, such as the mixed WAV). `make` returns
 * null when there is nothing to save, and then the click saves nothing.
 * @typedef {{name: string, label: string, hint: string, blob?: Blob, make?: () => Blob | null}} DownloadFile
 */

/**
 * Build the download buttons inside `container`.
 *
 * @param {HTMLElement} container
 * @param {{setTimer?: (run: () => void, delay: number) => any, clearTimer?: (id: any) => void}} [timers]
 *   the clock, replaced by the tests
 * @returns {{set: (files: DownloadFile[]) => void, clear: () => void}}
 */
export function createDownloads(container, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  container.classList.add("downloads");
  /** @type {Set<string>} the object URLs alive now */
  const urls = new Set();
  /** @type {Set<any>} the pending releases of made files */
  const releases = new Set();

  /** @param {string} url */
  function release(url) {
    URL.revokeObjectURL(url);
    urls.delete(url);
  }

  function clear() {
    for (const id of releases) clearTimer(id);
    releases.clear();
    urls.forEach((url) => URL.revokeObjectURL(url));
    urls.clear();
    container.innerHTML = "";
  }

  return {
    set(files) {
      clear();
      for (const file of files) {
        const link = document.createElement("a");
        link.className = "button";
        link.download = file.name;
        if (file.blob) {
          const url = URL.createObjectURL(file.blob);
          urls.add(url);
          link.href = url;
        } else if (file.make) {
          const make = file.make;
          // The link has no address until it is used; a click sets it just before the browser follows it.
          link.href = "#";
          /** @type {string | null} the address of the file made by the last click */
          let made = null;
          /** @type {any} the pending release of that file */
          let pending = null;
          link.addEventListener("click", (event) => {
            const blob = make();
            if (!blob) {
              event.preventDefault();
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
            link.href = url;
            pending = setTimer(() => {
              releases.delete(pending);
              pending = null;
              made = null;
              release(url);
            }, MADE_FILE_LINGER_MS);
            releases.add(pending);
          });
        }
        link.title = file.hint;
        link.innerHTML = `<span>${file.label}</span><span class="file mono"></span>`;
        /** @type {HTMLElement} */ (link.querySelector(".file")).textContent = file.name;
        container.append(link);
      }
    },
    clear,
  };
}
