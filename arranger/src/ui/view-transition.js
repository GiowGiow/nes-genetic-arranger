// @ts-check
/**
 * View transitions: tab and view changes that cross-fade and slide a few pixels.
 *
 * Switching a tab only toggles `hidden`, which is an instant swap. Where the browser supports the
 * View Transitions API (`document.startViewTransition`), the swap is wrapped in a transition: the
 * browser takes a picture of the old page and the new one and cross-fades them, with a slide in
 * the direction of the tab order (motion.css, `::view-transition-old(root)`). The API snapshots
 * the whole page, which a phone's blurred cards make expensive, so it is used only with a mouse
 * and with motion allowed. Everywhere else the change is made at once and a plain CSS entrance
 * (`panel-in`, which only moves `opacity` and `transform`) animates the arriving panel.
 *
 * Several changes asked for in one turn (the Run tab and its Result view, when a run ends) share
 * one transition: they are collected and applied together in a microtask.
 */

/**
 * Whether to use view transitions.
 *
 * @param {{supported: boolean, reducedMotion: boolean, coarsePointer: boolean}} conditions
 * @returns {boolean}
 * @example
 * shouldUseTransitions({ supported: true, reducedMotion: false, coarsePointer: true }); // false
 */
export function shouldUseTransitions({ supported, reducedMotion, coarsePointer }) {
  return supported && !reducedMotion && !coarsePointer;
}

/**
 * Which way a change slides.
 *
 * @param {number} from index of the tab being left
 * @param {number} to index of the tab being opened
 * @returns {"forward" | "back" | "none"}
 * @example
 * slideDirection(0, 2); // "forward"
 */
export function slideDirection(from, to) {
  if (to > from) return "forward";
  if (to < from) return "back";
  return "none";
}

/**
 * Make the transitioner.
 *
 * @param {object} [parts]
 * @param {Document} [parts.document]
 * @param {() => boolean} [parts.reducedMotion] read at each change, so the system setting can change under a visit
 * @param {() => boolean} [parts.coarsePointer]
 * @returns {{run: (update: () => void, direction?: "forward" | "back" | "none") => void}}
 * @example
 * const transitions = createTransitioner();
 * transitions.run(() => { panel.hidden = false; }, slideDirection(oldIndex, newIndex));
 */
export function createTransitioner({
  document = globalThis.document,
  reducedMotion = () => Boolean(globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches),
  coarsePointer = () => Boolean(globalThis.matchMedia?.("(pointer: coarse)").matches),
} = {}) {
  const supported = () => typeof document?.startViewTransition === "function";
  const usable = () => shouldUseTransitions({ supported: supported(), reducedMotion: reducedMotion(), coarsePointer: coarsePointer() });
  // The CSS entrance steps aside when the browser's transition is on.
  if (usable()) document.documentElement.classList.add("vt-on");

  /** @type {Array<() => void>} */
  let queued = [];
  /** @type {"forward" | "back" | "none"} */
  let direction = "none";
  let scheduled = false;

  function flush() {
    scheduled = false;
    const updates = queued;
    queued = [];
    const slide = direction;
    direction = "none";
    const apply = () => {
      for (const update of updates) {
        try {
          update();
        } catch (error) {
          // One panel failing must not leave the others half changed.
          console.error(error);
        }
      }
    };
    if (!usable()) {
      apply();
      return;
    }
    const root = document.documentElement;
    if (slide !== "none") root.dataset.slide = slide;
    const transition = document.startViewTransition(apply);
    const clear = () => {
      delete root.dataset.slide;
    };
    transition.finished.then(clear, clear);
    // A transition the browser skips (a hidden tab, a newer transition) rejects these promises;
    // the change itself has been applied, so there is nothing to report.
    transition.ready?.catch(() => {});
    transition.updateCallbackDone?.catch(() => {});
  }

  return {
    run(update, slide = "none") {
      if (!usable()) {
        update();
        return;
      }
      queued.push(update);
      if (direction === "none") direction = slide;
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(flush);
      }
    },
  };
}
