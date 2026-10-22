// @ts-check
// Tests for ui/downloads.js: the download links of a run. Each link holds an object URL, and an
// object URL keeps its file in memory until it is revoked (a WAV is 17 MB), so the rule is that
// the page never holds more URLs than the links on screen need: a new run, a clear and a repeated
// click give back what they replace, and a file made on a click is given back a minute after.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createDownloads } from "../src/ui/downloads.js";

/** A link or container of the fake page: listeners, children, and a child found by selector. */
class FakeElement {
  constructor() {
    this.className = "";
    this.href = "";
    this.download = "";
    this.title = "";
    /** @type {FakeElement[]} */
    this.children = [];
    /** @type {Record<string, Array<(event: {preventDefault: () => void}) => void>>} */
    this.listeners = {};
    this.classList = { add: () => {} };
    this.file = { textContent: "" };
  }
  /** @param {FakeElement} node */
  append(node) {
    this.children.push(node);
  }
  set innerHTML(html) {
    this.children = [];
  }
  get innerHTML() {
    return "";
  }
  querySelector() {
    return this.file;
  }
  /** @param {string} type @param {(event: {preventDefault: () => void}) => void} listener */
  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  /** Click the link; returns true when the click went on to save the file. */
  click() {
    let prevented = false;
    for (const listener of this.listeners.click ?? []) listener({ preventDefault: () => (prevented = true) });
    return !prevented;
  }
}

/** Runs `body` with a fake `document` and `URL.createObjectURL`, and gives it the live URLs. */
async function withFakePage(/** @type {(live: Set<string>) => void | Promise<void>} */ body) {
  const live = new Set();
  let counter = 0;
  const realDocument = globalThis.document;
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  globalThis.document = /** @type {any} */ ({ createElement: () => new FakeElement() });
  URL.createObjectURL = () => {
    const url = `blob:fake/${++counter}`;
    live.add(url);
    return url;
  };
  URL.revokeObjectURL = (url) => void live.delete(url);
  try {
    await body(live);
  } finally {
    globalThis.document = realDocument;
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
  }
}

/** A timer the test runs by hand. */
function manualTimers() {
  /** @type {Map<number, () => void>} */
  const pending = new Map();
  let next = 0;
  return {
    pending,
    setTimer: (/** @type {() => void} */ run) => {
      pending.set(++next, run);
      return next;
    },
    clearTimer: (/** @type {number} */ id) => void pending.delete(id),
    runAll() {
      for (const [id, run] of [...pending]) {
        pending.delete(id);
        run();
      }
    },
  };
}

const blobFile = (/** @type {string} */ name) => ({ name, label: name, hint: name, blob: new Blob([name]) });
const madeFile = (/** @type {string} */ name) => ({ name, label: name, hint: name, make: () => new Blob([name]) });

test("every set gives back the URLs of the files it replaces: ten runs leave only the last run's", async () => {
  await withFakePage((live) => {
    const downloads = createDownloads(/** @type {any} */ (new FakeElement()));
    for (let run = 0; run < 10; run += 1) downloads.set([blobFile("a.mid"), blobFile("a.json"), madeFile("a.wav"), blobFile("a.abc")]);
    assert.equal(live.size, 3, "three blobs on screen; the WAV has no URL until it is clicked");
    downloads.clear();
    assert.equal(live.size, 0);
  });
});

test("clicking a made file again replaces its URL, so the old copy is not kept", async () => {
  await withFakePage(async (live) => {
    const timers = manualTimers();
    const container = new FakeElement();
    const downloads = createDownloads(/** @type {any} */ (container), timers);
    downloads.set([madeFile("a.wav")]);
    const link = container.children[0];
    for (let click = 0; click < 8; click += 1) assert.equal(link.click(), true);
    assert.equal(live.size, 1, "one live copy after eight clicks");
    assert.equal(timers.pending.size, 1, "one pending release, not eight");
  });
});

test("a made file is released a minute after its click, when the browser has long since saved it", async () => {
  await withFakePage((live) => {
    const timers = manualTimers();
    const container = new FakeElement();
    const downloads = createDownloads(/** @type {any} */ (container), timers);
    downloads.set([madeFile("a.wav"), blobFile("a.mid")]);
    container.children[0].click();
    assert.equal(live.size, 2);
    timers.runAll();
    assert.equal(live.size, 1, "the 17 MB copy is gone, the small MIDI stays for a second click");
    downloads.clear();
    assert.equal(live.size, 0);
  });
});

test("clearing cancels the pending release and gives the URLs back at once", async () => {
  await withFakePage((live) => {
    const timers = manualTimers();
    const container = new FakeElement();
    const downloads = createDownloads(/** @type {any} */ (container), timers);
    downloads.set([madeFile("a.wav")]);
    container.children[0].click();
    downloads.clear();
    assert.equal(live.size, 0);
    assert.equal(timers.pending.size, 0);
  });
});

test("a file that has nothing to save leaves no URL and the click is cancelled", async () => {
  await withFakePage((live) => {
    const container = new FakeElement();
    const downloads = createDownloads(/** @type {any} */ (container));
    downloads.set([{ name: "a.wav", label: "WAV", hint: "", make: () => null }]);
    assert.equal(container.children[0].click(), false);
    assert.equal(live.size, 0);
  });
});
