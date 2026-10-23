// @ts-check
// A small fake DOM for the tests of the page glue (busy.js, notify.js, drawers.js,
// catalog-glue.js). Node has no DOM: these classes keep what the glue reads and writes (classes,
// attributes, child nodes, text, listeners, focus) and nothing else. Not a test itself:
// node --test only runs `*.test.js`.

/** A text node: only its text. */
export class FakeText {
  /** @param {string} data */
  constructor(data) {
    this.data = data;
    this.nodeType = 3;
    /** @type {FakeElement | null} */
    this.parent = null;
  }
  get textContent() {
    return this.data;
  }
}

/** A set of class names with the parts of `classList` the glue uses. */
class FakeClassList {
  constructor() {
    /** @type {Set<string>} */
    this.names = new Set();
  }
  /** @param {...string} names */
  add(...names) {
    for (const name of names) this.names.add(name);
  }
  /** @param {...string} names */
  remove(...names) {
    for (const name of names) this.names.delete(name);
  }
  /** @param {string} name @param {boolean} [force] */
  toggle(name, force) {
    const on = force ?? !this.names.has(name);
    if (on) this.names.add(name);
    else this.names.delete(name);
    return on;
  }
  /** @param {string} name */
  contains(name) {
    return this.names.has(name);
  }
}

/** An element: child nodes, attributes, classes, text, listeners and focus. */
export class FakeElement {
  /**
   * @param {string} tagName
   * @param {FakeDocument} [ownerDocument]
   */
  constructor(tagName, ownerDocument = new FakeDocument()) {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.ownerDocument = ownerDocument;
    /** @type {Array<FakeElement | FakeText>} */
    this.childNodes = [];
    /** @type {FakeElement | null} */
    this.parent = null;
    /** @type {Map<string, string>} */
    this.attributes = new Map();
    this.classList = new FakeClassList();
    /** @type {Record<string, Array<(event: any) => void>>} */
    this.listeners = {};
    this.style = /** @type {Record<string, string>} */ ({});
    this.disabled = false;
    this.hidden = false;
    this.offsetWidth = 0;
    this.focusCount = 0;
  }
  get children() {
    return /** @type {FakeElement[]} */ (this.childNodes.filter((node) => node.nodeType === 1));
  }
  get textContent() {
    return this.childNodes.map((node) => node.textContent).join("");
  }
  set textContent(text) {
    this.replaceChildren(...(text === "" ? [] : [new FakeText(String(text))]));
  }
  get className() {
    return [...this.classList.names].join(" ");
  }
  set className(value) {
    this.classList.names = new Set(String(value).split(/\s+/).filter(Boolean));
  }
  /** @param {...(FakeElement | FakeText | string)} nodes */
  append(...nodes) {
    for (const node of nodes) {
      const child = typeof node === "string" ? new FakeText(node) : node;
      child.parent = this;
      this.childNodes.push(child);
    }
  }
  /** @param {...(FakeElement | FakeText | string)} nodes */
  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parent = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  remove() {
    if (!this.parent) return;
    this.parent.childNodes = this.parent.childNodes.filter((node) => node !== this);
    this.parent = null;
  }
  /** @param {FakeElement | FakeText | null | undefined} node */
  contains(node) {
    for (let current = node; current; current = current.parent) if (current === this) return true;
    return false;
  }
  /** @param {string} name @param {string} value */
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  /** @param {string} name */
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  /** @param {string} name */
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  /** @param {string} name */
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  /** @param {string} type @param {(event: any) => void} listener */
  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  /** @param {string} type @param {object} [event] */
  dispatch(type, event = {}) {
    for (const listener of this.listeners[type] ?? []) listener({ type, target: this, ...event });
  }
  click() {
    this.dispatch("click");
  }
  focus() {
    this.focusCount += 1;
    this.ownerDocument.activeElement = this;
  }
  /** @param {string} selector a class (".toast") or a tag ("button"): all the tests need */
  querySelectorAll(selector) {
    /** @type {FakeElement[]} */
    const found = [];
    const visit = (/** @type {FakeElement} */ element) => {
      for (const child of element.children) {
        const matches = selector.startsWith(".") ? child.classList.contains(selector.slice(1)) : child.tagName === selector.toUpperCase();
        if (matches) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  /** @param {string} selector */
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

/** A document that makes elements and knows which one has the focus. */
export class FakeDocument {
  constructor() {
    /** @type {FakeElement | null} */
    this.activeElement = null;
    /** @type {Record<string, Array<(event: any) => void>>} */
    this.listeners = {};
  }
  /** @param {string} tagName */
  createElement(tagName) {
    return new FakeElement(tagName, this);
  }
  /** @param {string} type @param {(event: any) => void} listener */
  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }
}

/**
 * A timer that runs only when the test says so: `setTimer` and `clearTimer` for the code under
 * test, `advance(ms)` for the test.
 * @returns {{setTimer: (run: () => void, ms: number) => number, clearTimer: (id: number) => void, advance: (ms: number) => void, pending: () => number}}
 */
export function createManualClock() {
  let now = 0;
  let nextId = 1;
  /** @type {Map<number, {at: number, run: () => void}>} */
  const timers = new Map();
  return {
    setTimer(run, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advance(ms) {
      // Run the timers in the order of their time, so one that a timer starts is run too if it is due.
      const target = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= target).sort((x, y) => x[1].at - y[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].run();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}
