// @ts-check
// Toasts: short messages that appear where the visitor is looking.
//
// The page used to write every status and error to one muted line under the song shelf, which on
// a phone sits 700 pixels below the screen. A toast is a small card in a fixed corner of the
// screen (the top on a phone, the bottom right on a desktop), inside one live region
// (`<div class="toast-region" role="status" aria-live="polite" data-toasts>`), so a screen reader
// announces each message once.
//
// Rules:
// - Information fades by itself after 6 seconds; an error stays until the visitor dismisses it,
//   because a failure that vanishes while they look elsewhere is a failure they never learn of.
//   Either can name its own time (`timeout`, in milliseconds; 0 keeps it until dismissed).
// - The same message again does not add a second card: the first stays and its time starts over.
// - At most four cards show at once; a fifth makes the oldest leave.
// - A toast can carry one action (for example Retry).
// - Leaving is a short fade (the class `is-leaving`, `LEAVE_MS`), then the card is removed.
//
// `createNotifier` takes its region and its timers as parameters so the tests can run it on a
// fake page with a clock they move by hand. `notify` is the shared one, bound to the page's
// region the first time it is used; without a region (Node, or a page that lacks it) it does
// nothing.

/** How long an information toast stays, in milliseconds. */
export const INFO_MS = 6000;

/** How long the leave fade lasts before the card is removed, in milliseconds (motion.css `--dur-2`). */
export const LEAVE_MS = 160;

/** The most toasts on screen at once. */
export const MAX_VISIBLE = 4;

/**
 * What a caller may ask of a toast.
 * @typedef {object} NotifyOptions
 * @property {"info" | "error"} [kind] default "info"
 * @property {number} [timeout] milliseconds until it leaves; 0 keeps it. Default: 6000 for
 *   information, none for an error
 * @property {{label: string, run: () => void}} [action] one button that runs `run` and dismisses
 */

/**
 * A toast on screen.
 * @typedef {object} Toast
 * @property {() => void} dismiss take it away (harmless if it is already leaving)
 */

/**
 * @typedef {object} Notifier
 * @property {(message: string, options?: NotifyOptions) => Toast | null} notify show a toast; null for an empty message or no region
 * @property {() => void} dismissAll
 */

/**
 * Make a notifier that shows toasts in a region.
 *
 * @param {object} parts
 * @param {HTMLElement | null} parts.region the toast area, or null for a notifier that does nothing
 * @param {(run: () => void, ms: number) => any} [parts.setTimer] default `setTimeout`
 * @param {(id: any) => void} [parts.clearTimer] default `clearTimeout`
 * @returns {Notifier}
 * @example
 * const notifier = createNotifier({ region: document.querySelector("[data-toasts]") });
 * notifier.notify("Saved for next time"); // gone after 6 s
 * notifier.notify("The catalog could not be loaded", { kind: "error" }); // stays until dismissed
 */
export function createNotifier({ region, setTimer = (run, ms) => setTimeout(run, ms), clearTimer = (id) => clearTimeout(id) }) {
  /** @type {Array<{message: string, kind: string, element: HTMLElement, timer: any, leaving: boolean, handle: Toast}>} */
  const shown = [];

  /** @param {(typeof shown)[number]} toast */
  function leave(toast) {
    if (toast.leaving) return;
    toast.leaving = true;
    clearTimer(toast.timer);
    toast.element.classList.add("is-leaving");
    setTimer(() => {
      toast.element.remove();
      shown.splice(shown.indexOf(toast), 1);
    }, LEAVE_MS);
  }

  /** @param {(typeof shown)[number]} toast @param {number} timeout */
  function startClock(toast, timeout) {
    clearTimer(toast.timer);
    toast.timer = timeout > 0 ? setTimer(() => leave(toast), timeout) : null;
  }

  return {
    notify(message, { kind = "info", timeout = kind === "error" ? 0 : INFO_MS, action } = {}) {
      if (!region || message.trim() === "") return null;
      const same = shown.find((toast) => !toast.leaving && toast.message === message && toast.kind === kind);
      if (same) {
        startClock(same, timeout);
        return same.handle;
      }

      const document = region.ownerDocument;
      const element = document.createElement("div");
      element.className = `toast ${kind}`;
      if (kind === "error") element.setAttribute("role", "alert");
      const text = document.createElement("span");
      text.className = "toast-text";
      text.textContent = message;
      element.append(text);

      /** @type {(typeof shown)[number]} */
      const toast = { message, kind, element, timer: null, leaving: false, handle: { dismiss: () => leave(toast) } };
      if (action) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "button quiet small toast-action";
        button.textContent = action.label;
        button.addEventListener("click", () => {
          action.run();
          leave(toast);
        });
        element.append(button);
      }
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "button quiet small toast-dismiss";
      dismiss.textContent = "Dismiss";
      dismiss.addEventListener("click", () => leave(toast));
      element.append(dismiss);

      region.append(element);
      shown.push(toast);
      startClock(toast, timeout);
      const visible = shown.filter((other) => !other.leaving);
      if (visible.length > MAX_VISIBLE) leave(visible[0]);
      return toast.handle;
    },
    dismissAll() {
      for (const toast of [...shown]) leave(toast);
    },
  };
}

/** @type {Notifier | null} the page's notifier, made on first use */
let pageNotifier = null;

/** @returns {Notifier} */
function shared() {
  pageNotifier ??= createNotifier({ region: globalThis.document?.querySelector("[data-toasts]") ?? null });
  return pageNotifier;
}

/**
 * Show a toast in the page's toast region.
 *
 * @param {string} message
 * @param {NotifyOptions} [options]
 * @returns {Toast | null} a handle to dismiss it early, or null when there is nothing to show
 * @example
 * notify("Every channel is muted: nothing to save.");
 * notify("The Session could not be reached.", { kind: "error", action: { label: "Retry", run: search } });
 */
export function notify(message, options) {
  return shared().notify(message, options);
}

/**
 * A function for the places that write one status line that changes over time ("Loading X…",
 * then "X: ready to arrange."): each line becomes a toast that replaces the one before it, and an
 * empty line takes the last one away.
 *
 * @param {Notifier} notifier
 * @returns {(text: string, isError?: boolean) => void}
 * @example
 * const status = createStatusRelay(createNotifier({ region }));
 * status("Loading Korobeiniki…");
 * status("Korobeiniki: ready to arrange."); // replaces the first toast
 */
export function createStatusRelay(notifier) {
  /** @type {Toast | null} */
  let last = null;
  return (text, isError = false) => {
    last?.dismiss();
    last = notifier.notify(text, { kind: isError ? "error" : "info" });
  };
}

/**
 * The page's shared status relay: `statusToast("Loading…")`.
 * @type {(text: string, isError?: boolean) => void}
 */
export const statusToast = (() => {
  /** @type {((text: string, isError?: boolean) => void) | null} */
  let relay = null;
  return (text, isError) => {
    relay ??= createStatusRelay(shared());
    relay(text, isError);
  };
})();
