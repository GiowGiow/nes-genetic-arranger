// @ts-check
// Busy states: the one way the page shows that something is working.
//
// A visitor who presses Arrange, Preview or Download needs to know the page heard them, and a
// screen-reader user needs it said aloud. So a busy control does four things together: it sets
// `aria-busy="true"` (the standard way to tell assistive technology that a region is updating),
// gets the class `is-busy` (style.css draws a small spinning record in front of the label), cannot
// be pressed a second time, and shows a short word for the work ("Evolving…") in place of its
// label. When the work ends, everything comes back exactly as it was.
//
// A button is disabled with the `disabled` property. A link cannot be disabled, so it gets
// `aria-disabled` (and style.css ignores pointer events on `.is-busy`). A region such as the
// shelf or the result card only gets `aria-busy` and the class: its own content shows the
// loading state, and its text is never swapped.
//
// Tests run without a browser (tests/busy.test.js), on a small fake DOM.

/** The word a busy button shows when its caller gives none. */
export const DEFAULT_BUSY_LABEL = "Working…";

/**
 * What a busy control must give back when the work ends.
 * @typedef {object} Saved
 * @property {Array<Node>} nodes the label, as the child nodes the control had
 * @property {boolean} disabled whether a button was disabled before it became busy
 * @property {string} minWidth the inline `min-width` before the width was pinned
 */

/** @type {WeakMap<HTMLElement, Saved>} controls that are busy now, with what to restore */
const busyControls = new WeakMap();

/** @type {WeakMap<HTMLElement, number>} how many `withBusy` jobs are running on a control */
const jobCounts = new WeakMap();

/**
 * Buttons and links show a label; anything else (a card, a list) is only marked.
 * @param {HTMLElement} element
 */
function isControl(element) {
  return element.tagName === "BUTTON" || element.tagName === "A";
}

/**
 * Is this element marked busy right now?
 * @param {HTMLElement} element
 * @returns {boolean}
 * @example
 * setBusy(button, true);
 * isBusy(button); // true
 */
export function isBusy(element) {
  return element.getAttribute("aria-busy") === "true";
}

/**
 * Mark an element busy, or give it back.
 *
 * Busy: `aria-busy="true"` and the class `is-busy`; a button or link also shows `label` in place
 * of its own label (keeping its width, so the row does not move) and cannot be pressed again.
 * Not busy: all of that is undone, and a button that was disabled before stays disabled.
 *
 * @param {HTMLElement} element a button, a link or a region
 * @param {boolean} busy
 * @param {string} [label] the short busy word for a button or link (default "Working…")
 * @example
 * setBusy(arrangeButton, true, "Evolving…"); // the button reads "Evolving…" and is disabled
 * setBusy(arrangeButton, false); // it reads "Arrange" again
 */
export function setBusy(element, busy, label = DEFAULT_BUSY_LABEL) {
  if (!busy) {
    clearBusy(element);
    return;
  }
  element.setAttribute("aria-busy", "true");
  element.classList.add("is-busy");
  if (!isControl(element)) return;

  let saved = busyControls.get(element);
  if (!saved) {
    saved = {
      nodes: Array.from(element.childNodes),
      disabled: /** @type {HTMLButtonElement} */ (element).disabled === true,
      minWidth: element.style.minWidth ?? "",
    };
    busyControls.set(element, saved);
    // Pin the width before the label changes: "Download WAV" and "Preparing…" differ in length.
    if (element.offsetWidth > 0) element.style.minWidth = `${element.offsetWidth}px`;
  }
  element.textContent = label;
  if (element.tagName === "BUTTON") /** @type {HTMLButtonElement} */ (element).disabled = true;
  else element.setAttribute("aria-disabled", "true");
}

/**
 * Undo `setBusy(element, true)`.
 * @param {HTMLElement} element
 */
function clearBusy(element) {
  element.removeAttribute("aria-busy");
  element.classList.remove("is-busy");
  const saved = busyControls.get(element);
  if (!saved) return;
  busyControls.delete(element);
  element.replaceChildren(...saved.nodes);
  element.style.minWidth = saved.minWidth;
  if (element.tagName === "BUTTON") /** @type {HTMLButtonElement} */ (element).disabled = saved.disabled;
  else element.removeAttribute("aria-disabled");
}

/**
 * Keep an element busy for as long as some work takes, whether it succeeds or fails.
 *
 * Several jobs on one element overlap safely: it stays busy until the last one ends.
 *
 * @template T
 * @param {HTMLElement} element
 * @param {Promise<T> | (() => Promise<T>)} work a promise, or a function that starts the work once
 *   the element shows its busy state
 * @param {string} [label] the busy word for a button or link
 * @returns {Promise<T>} what the work gives (or its failure)
 * @example
 * const song = await withBusy(previewButton, readSong(entry), "Reading…");
 */
export async function withBusy(element, work, label) {
  jobCounts.set(element, (jobCounts.get(element) ?? 0) + 1);
  setBusy(element, true, label);
  try {
    return await (typeof work === "function" ? work() : work);
  } finally {
    const running = (jobCounts.get(element) ?? 1) - 1;
    jobCounts.set(element, running);
    if (running === 0) setBusy(element, false);
  }
}
