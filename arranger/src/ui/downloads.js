// @ts-check
/**
 * Downloads: the three files that keep a run (spec 002, FR-024 and FR-025).
 *
 * - `<run id>.mid`: the arrangement as a four-track MIDI file (P1, P2, TR, NO);
 * - `<run id>.config.json`: the run record, which the command line accepts with `--config`;
 * - `<run id>.abc`: the lead sheet the run arranged, so a MIDI song can be rerun without its file.
 *
 * The files are made in the browser and saved by the browser; nothing is uploaded.
 */

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
 * @returns {{set: (files: DownloadFile[]) => void, clear: () => void}}
 */
export function createDownloads(container) {
  container.classList.add("downloads");
  /** @type {string[]} */
  let urls = [];

  function clear() {
    urls.forEach((url) => URL.revokeObjectURL(url));
    urls = [];
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
          urls.push(url);
          link.href = url;
        } else if (file.make) {
          const make = file.make;
          // The link has no address until it is used; a click sets it just before the browser follows it.
          link.href = "#";
          /** @type {string | null} the address of the file made by the last click */
          let made = null;
          link.addEventListener("click", (event) => {
            const blob = make();
            if (!blob) {
              event.preventDefault();
              return;
            }
            // One file per link at a time: the earlier click's copy has been saved by now.
            if (made) URL.revokeObjectURL(made);
            made = URL.createObjectURL(blob);
            urls.push(made);
            link.href = made;
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
