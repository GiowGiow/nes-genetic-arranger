// @ts-check
// Tests for ui/downloads.js: the download links of a run. Each link holds an object URL, and an
// object URL keeps its file in memory until it is revoked (a WAV is 17 MB), so the rule is that
// the page never holds more URLs than the links on screen need: a new run, a clear and a repeated
// click give back what they replace, and a file made on a click is given back a minute after.
//
// A click on a file made on demand is a small job with a visible state (audit L14): the link
// shows its busy state while the file is made, a muted song says why nothing was saved, a second
// click while busy does nothing, and every link shows a tick when it has saved.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createDownloads, formatSize } from "../src/ui/downloads.js";
import { FakeDocument } from "./fake-dom.js";

/** Runs `body` with a fake `document` and `URL.createObjectURL`, and gives it the live URLs. */
async function withFakePage(/** @type {(live: Set<string>, document: FakeDocument) => void | Promise<void>} */ body) {
  const live = new Set();
  let counter = 0;
  const document = new FakeDocument();
  const realDocument = globalThis.document;
  const realCreate = URL.createObjectURL;
  const realRevoke = URL.revokeObjectURL;
  globalThis.document = /** @type {any} */ (document);
  URL.createObjectURL = () => {
    const url = `blob:fake/${++counter}`;
    live.add(url);
    return url;
  };
  URL.revokeObjectURL = (url) => void live.delete(url);
  try {
    await body(live, document);
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

/** The parts a test passes: manual timers, a frame wait the test releases, and recorders. */
function parts() {
  const timers = manualTimers();
  /** @type {Array<() => void>} */
  const frames = [];
  /** @type {Array<[string, string]>} */
  const saved = [];
  /** @type {string[]} */
  const messages = [];
  return {
    timers,
    saved,
    messages,
    nextFrameCount: () => frames.length,
    /** Let the page "paint": the waiting frame resolves. */
    paint() {
      frames.splice(0).forEach((resolve) => resolve());
    },
    options: {
      ...timers,
      nextFrame: () => new Promise((resolve) => frames.push(() => resolve(undefined))),
      save: (/** @type {string} */ url, /** @type {string} */ name) => saved.push([url, name]),
      notify: (/** @type {string} */ message) => void messages.push(message),
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

const blobFile = (/** @type {string} */ name) => ({ name, label: name, hint: name, blob: new Blob([name]) });
const madeFile = (/** @type {string} */ name, /** @type {() => Blob | null} */ make = () => new Blob([name])) => ({ name, label: name, hint: name, make });

/** Click a link and let the whole job (including the page's paint) finish. @param {any} link @param {ReturnType<typeof parts>} setup */
async function clickAndFinish(link, setup) {
  link.click();
  await settle();
  setup.paint();
  await settle();
}

test("every set gives back the URLs of the files it replaces: ten runs leave only the last run's", async () => {
  await withFakePage((live, document) => {
    const downloads = createDownloads(/** @type {any} */ (document.createElement("div")), parts().options);
    for (let run = 0; run < 10; run += 1) downloads.set([blobFile("a.mid"), blobFile("a.json"), madeFile("a.wav"), blobFile("a.abc")]);
    assert.equal(live.size, 3, "three blobs on screen; the WAV has no URL until it is clicked");
    downloads.clear();
    assert.equal(live.size, 0);
  });
});

test("clicking a made file again replaces its URL, so the old copy is not kept", async () => {
  await withFakePage(async (live, document) => {
    const setup = parts();
    const container = document.createElement("div");
    const downloads = createDownloads(/** @type {any} */ (container), setup.options);
    downloads.set([madeFile("a.wav")]);
    const link = container.children[0];
    for (let click = 0; click < 8; click += 1) await clickAndFinish(link, setup);
    assert.equal(live.size, 1, "one live copy after eight clicks");
    assert.equal(setup.saved.length, 8, "each click saved the file");
    assert.equal(setup.timers.pending.size, 2, "one pending release and one saved tick, not eight of each");
  });
});

test("a made file is released a minute after its click, when the browser has long since saved it", async () => {
  await withFakePage(async (live, document) => {
    const setup = parts();
    const container = document.createElement("div");
    const downloads = createDownloads(/** @type {any} */ (container), setup.options);
    downloads.set([madeFile("a.wav"), blobFile("a.mid")]);
    await clickAndFinish(container.children[0], setup);
    assert.equal(live.size, 2);
    setup.timers.runAll();
    assert.equal(live.size, 1, "the 17 MB copy is gone, the small MIDI stays for a second click");
    downloads.clear();
    assert.equal(live.size, 0);
  });
});

test("clearing cancels the pending release and gives the URLs back at once", async () => {
  await withFakePage(async (live, document) => {
    const setup = parts();
    const container = document.createElement("div");
    const downloads = createDownloads(/** @type {any} */ (container), setup.options);
    downloads.set([madeFile("a.wav")]);
    await clickAndFinish(container.children[0], setup);
    downloads.clear();
    assert.equal(live.size, 0);
    assert.equal(setup.timers.pending.size, 0);
  });
});

test("while the file is made the link is busy and the page gets a frame to paint that first", async () => {
  await withFakePage(async (live, document) => {
    const setup = parts();
    let made = 0;
    const container = document.createElement("div");
    const downloads = createDownloads(/** @type {any} */ (container), setup.options);
    downloads.set([{ ...madeFile("a.wav", () => (made += 1, new Blob(["x"]))), busyLabel: "Mixing…" }]);
    const link = container.children[0];

    link.click();
    await settle();

    assert.equal(link.getAttribute("aria-busy"), "true");
    assert.equal(link.textContent, "Mixing…");
    assert.equal(made, 0, "the work waits for the page to paint the busy state");
    setup.paint();
    await settle();
    assert.equal(made, 1);
    assert.equal(link.getAttribute("aria-busy"), null, "busy ends with the work");
    assert.deepEqual(setup.saved, [["blob:fake/1", "a.wav"]]);
  });
});

test("a second click while the file is being made does nothing", async () => {
  await withFakePage(async (live, document) => {
    const setup = parts();
    let made = 0;
    const container = document.createElement("div");
    const downloads = createDownloads(/** @type {any} */ (container), setup.options);
    downloads.set([madeFile("a.wav", () => (made += 1, new Blob(["x"])))]);
    const link = container.children[0];

    link.click();
    link.click();
    await settle();
    setup.paint();
    await settle();

    assert.equal(made, 1);
    assert.equal(setup.saved.length, 1);
  });
});

test("a file that has nothing to save leaves no URL, says why, and ends the busy state", async () => {
  await withFakePage(async (live, document) => {
    const setup = parts();
    const container = document.createElement("div");
    const downloads = createDownloads(/** @type {any} */ (container), setup.options);
    downloads.set([{ ...madeFile("a.wav", () => null), emptyMessage: "Every channel is muted: nothing to save." }]);
    const link = container.children[0];

    await clickAndFinish(link, setup);

    assert.equal(live.size, 0);
    assert.deepEqual(setup.messages, ["Every channel is muted: nothing to save."]);
    assert.equal(link.getAttribute("aria-busy"), null);
    assert.deepEqual(setup.saved, []);
    assert.equal(link.classList.contains("is-saved"), false, "nothing was saved, so no tick");
  });
});

test("a file that cannot be made reports the error and gives the link back", async () => {
  await withFakePage(async (live, document) => {
    const setup = parts();
    const container = document.createElement("div");
    const downloads = createDownloads(/** @type {any} */ (container), setup.options);
    downloads.set([madeFile("a.wav", () => {
      throw new Error("out of memory");
    })]);
    const link = container.children[0];

    await clickAndFinish(link, setup);

    assert.match(setup.messages[0], /a\.wav could not be made: out of memory/);
    assert.equal(link.getAttribute("aria-busy"), null);
  });
});

test("a saved file shows a tick for a moment, and then it goes", async () => {
  await withFakePage(async (live, document) => {
    const setup = parts();
    const container = document.createElement("div");
    const downloads = createDownloads(/** @type {any} */ (container), setup.options);
    downloads.set([madeFile("a.wav"), blobFile("a.mid")]);
    const [wav, midi] = container.children;

    await clickAndFinish(wav, setup);
    midi.click();

    assert.equal(wav.classList.contains("is-saved"), true);
    assert.equal(midi.classList.contains("is-saved"), true, "a plain link confirms its click too");
    setup.timers.runAll();
    assert.equal(wav.classList.contains("is-saved"), false);
    assert.equal(midi.classList.contains("is-saved"), false);
  });
});

test("each link wears its era's object: a cassette on the WAV, a floppy disk on the MIDI", async () => {
  await withFakePage((live, document) => {
    const container = document.createElement("div");
    const downloads = createDownloads(/** @type {any} */ (container), parts().options);
    downloads.set([blobFile("a.mid"), madeFile("a.wav")]);
    const [midi, wav] = container.children;
    const iconOf = (/** @type {any} */ link) => /** @type {any} */ (link.querySelector(".dl-icon")).innerHTML;

    assert.match(iconOf(midi), /<svg/);
    assert.notEqual(iconOf(midi), iconOf(wav));
    assert.match(iconOf(wav), /<circle/, "the cassette has its two reels");
  });
});

test("the size is shown beside the file name when it is known", async () => {
  await withFakePage((live, document) => {
    const container = document.createElement("div");
    const downloads = createDownloads(/** @type {any} */ (container), parts().options);
    downloads.set([{ ...madeFile("a.wav"), sizeText: "about 9 MB" }]);

    assert.equal(/** @type {any} */ (container.children[0].querySelector(".file")).textContent, "a.wav · about 9 MB");
  });
});

test("sizes read as megabytes from 1 MB up and kilobytes below", () => {
  assert.equal(formatSize(17_640_044), "about 18 MB");
  assert.equal(formatSize(2300), "about 2 KB");
  assert.equal(formatSize(20), "about 1 KB");
});
