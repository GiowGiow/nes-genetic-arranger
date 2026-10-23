// @ts-check
// Tests for ui/busy.js: the one way the page shows that something is working. They read as the
// rules of a busy control: it says so to screen readers, it cannot be pressed twice, it names
// the work in a short word, and it gives everything back exactly as it was.

import assert from "node:assert/strict";
import { test } from "node:test";

import { isBusy, setBusy, withBusy } from "../src/ui/busy.js";
import { FakeElement } from "./fake-dom.js";

/** @param {string} tag @param {string} label */
function control(tag, label) {
  const element = new FakeElement(tag);
  element.textContent = label;
  element.offsetWidth = 96;
  return element;
}

/** @param {any} element */
const asElement = (element) => /** @type {HTMLElement} */ (element);

test("a busy region says so with aria-busy and a class, and a quiet one has neither", () => {
  const region = new FakeElement("section");

  setBusy(asElement(region), true);
  assert.equal(region.getAttribute("aria-busy"), "true");
  assert.equal(region.classList.contains("is-busy"), true);
  assert.equal(isBusy(asElement(region)), true);

  setBusy(asElement(region), false);
  assert.equal(region.hasAttribute("aria-busy"), false, "aria-busy is removed, not set to false");
  assert.equal(region.classList.contains("is-busy"), false);
  assert.equal(isBusy(asElement(region)), false);
});

test("a busy region keeps its text: only buttons and links swap their label", () => {
  const region = new FakeElement("section");
  region.textContent = "Songs";

  setBusy(asElement(region), true, "Loading…");

  assert.equal(region.textContent, "Songs");
});

test("a busy button is disabled and shows the busy text, and gets its label and state back", () => {
  const button = control("button", "Arrange");

  setBusy(asElement(button), true, "Evolving…");
  assert.equal(button.disabled, true, "a second press cannot start a second job");
  assert.equal(button.textContent, "Evolving…");
  assert.equal(button.getAttribute("aria-busy"), "true");

  setBusy(asElement(button), false);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Arrange");
  assert.equal(button.hasAttribute("aria-busy"), false);
});

test("a button that was disabled before stays disabled when the work ends", () => {
  const button = control("button", "Arrange");
  button.disabled = true;

  setBusy(asElement(button), true, "Working…");
  setBusy(asElement(button), false);

  assert.equal(button.disabled, true, "busy must not enable a button that had no song to arrange");
});

test("without a label a button says Working…", () => {
  const button = control("button", "Preview");

  setBusy(asElement(button), true);

  assert.equal(button.textContent, "Working…");
});

test("the button keeps its width while its label changes, so the row does not move", () => {
  const button = control("button", "Download WAV");
  button.style.minWidth = "4em";

  setBusy(asElement(button), true, "Preparing…");
  assert.equal(button.style.minWidth, "96px");

  setBusy(asElement(button), false);
  assert.equal(button.style.minWidth, "4em", "the width it had before comes back");
});

test("a button made of several parts gets all its parts back, not just its text", () => {
  const download = control("button", "");
  const name = new FakeElement("span");
  name.textContent = "WAV";
  const size = new FakeElement("span");
  size.textContent = "about 17 MB";
  download.append(name, size);

  setBusy(asElement(download), true, "Preparing…");
  assert.equal(download.textContent, "Preparing…");
  setBusy(asElement(download), false);

  assert.deepEqual(download.children, [name, size]);
  assert.equal(download.textContent, "WAVabout 17 MB");
});

test("a link cannot be disabled, so a busy link says aria-disabled and swaps its label", () => {
  const link = control("a", "Audio (WAV)");

  setBusy(asElement(link), true, "Preparing…");
  assert.equal(link.getAttribute("aria-disabled"), "true");
  assert.equal(link.textContent, "Preparing…");

  setBusy(asElement(link), false);
  assert.equal(link.hasAttribute("aria-disabled"), false);
  assert.equal(link.textContent, "Audio (WAV)");
});

test("setting busy twice does not lose the real label", () => {
  const button = control("button", "Arrange");

  setBusy(asElement(button), true, "One…");
  setBusy(asElement(button), true, "Two…");
  assert.equal(button.textContent, "Two…");
  setBusy(asElement(button), false);

  assert.equal(button.textContent, "Arrange");
});

test("clearing a control that was never busy changes nothing", () => {
  const button = control("button", "Arrange");

  setBusy(asElement(button), false);

  assert.equal(button.textContent, "Arrange");
  assert.equal(button.disabled, false);
});

test("withBusy keeps the control busy while the work runs and gives the result back", async () => {
  const button = control("button", "Preview");
  /** @type {(value: number) => void} */
  let finish = () => {};
  const work = new Promise((resolve) => (finish = resolve));

  const done = withBusy(asElement(button), work, "Reading…");
  assert.equal(isBusy(asElement(button)), true, "busy from the moment it is called");
  assert.equal(button.textContent, "Reading…");

  finish(42);
  assert.equal(await done, 42);
  assert.equal(isBusy(asElement(button)), false);
  assert.equal(button.textContent, "Preview");
});

test("withBusy also clears the busy state when the work fails, and passes the failure on", async () => {
  const button = control("button", "Preview");

  await assert.rejects(withBusy(asElement(button), Promise.reject(new Error("no network")), "Reading…"), { message: "no network" });

  assert.equal(isBusy(asElement(button)), false);
  assert.equal(button.textContent, "Preview");
});

test("withBusy takes a function too, and starts it after the control shows its busy state", async () => {
  const button = control("button", "Preview");
  let seenInside = "";

  const result = await withBusy(
    asElement(button),
    async () => {
      seenInside = button.textContent;
      return "read";
    },
    "Reading…",
  );

  assert.equal(result, "read");
  assert.equal(seenInside, "Reading…");
});

test("two jobs on one control: it stays busy until the last one ends", async () => {
  const button = control("button", "Download");
  /** @type {Array<() => void>} */
  const finishers = [];
  const job = () => new Promise((resolve) => finishers.push(() => resolve(undefined)));

  const first = withBusy(asElement(button), job(), "Saving…");
  const second = withBusy(asElement(button), job(), "Saving…");
  finishers[0]();
  await first;
  assert.equal(isBusy(asElement(button)), true, "the second job is still running");

  finishers[1]();
  await second;
  assert.equal(isBusy(asElement(button)), false);
  assert.equal(button.textContent, "Download");
});
