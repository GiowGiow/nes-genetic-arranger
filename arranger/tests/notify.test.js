// @ts-check
// Tests for ui/notify.js: the toast region. Status and errors used to land in a muted line far
// below the fold; a toast puts them where the visitor is looking. The tests read as its rules:
// a toast lives in the one live region, information fades by itself and errors stay until
// dismissed, the same message does not pile up, and a status relay replaces the last message
// with the next one.

import assert from "node:assert/strict";
import { test } from "node:test";

import { LEAVE_MS, createNotifier, createStatusRelay, notify } from "../src/ui/notify.js";
import { FakeDocument, FakeElement, createManualClock } from "./fake-dom.js";

/** A notifier on a fake region and a clock the test moves by hand. */
function setUp(options = {}) {
  const document = new FakeDocument();
  const region = new FakeElement("div", document);
  const clock = createManualClock();
  const notifier = createNotifier({
    region: /** @type {any} */ (region),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...options,
  });
  const toasts = () => region.children;
  return { region, clock, notifier, toasts };
}

test("a message appears in the region as a toast with its text", () => {
  const { notifier, toasts } = setUp();

  notifier.notify("Saved for next time");

  assert.equal(toasts().length, 1);
  assert.equal(toasts()[0].classList.contains("toast"), true);
  assert.equal(toasts()[0].classList.contains("info"), true);
  assert.equal(toasts()[0].querySelector(".toast-text")?.textContent, "Saved for next time");
});

test("information goes away by itself after 6 seconds, with a short leave animation first", () => {
  const { notifier, clock, toasts } = setUp();
  notifier.notify("Saved for next time");

  clock.advance(5999);
  assert.equal(toasts().length, 1);
  clock.advance(1);
  assert.equal(toasts()[0].classList.contains("is-leaving"), true, "it starts to leave at 6 s");
  clock.advance(LEAVE_MS);
  assert.equal(toasts().length, 0, "and is removed once the animation has had time to run");
});

test("an error stays until the visitor dismisses it, and says it is an alert", () => {
  const { notifier, clock, toasts } = setUp();
  notifier.notify("bad.mid: the MIDI header is too short", { kind: "error" });

  clock.advance(60_000);
  assert.equal(toasts().length, 1, "no timer takes an error away");
  assert.equal(toasts()[0].classList.contains("error"), true);
  assert.equal(toasts()[0].getAttribute("role"), "alert");

  const dismiss = toasts()[0].querySelector("button");
  assert.equal(dismiss?.textContent, "Dismiss");
  dismiss?.click();
  clock.advance(LEAVE_MS);
  assert.equal(toasts().length, 0);
});

test("a toast can name its own time, and a time of 0 keeps it until dismissed", () => {
  const { notifier, clock, toasts } = setUp();

  notifier.notify("Quick", { timeout: 1000 });
  notifier.notify("Sticky info", { timeout: 0 });
  notifier.notify("Slow error", { kind: "error", timeout: 3000 });
  clock.advance(1000 + LEAVE_MS);
  assert.deepEqual(toasts().map((toast) => toast.querySelector(".toast-text")?.textContent), ["Sticky info", "Slow error"]);
  clock.advance(3000);
  clock.advance(LEAVE_MS);
  assert.deepEqual(toasts().map((toast) => toast.querySelector(".toast-text")?.textContent), ["Sticky info"]);
});

test("the same message again does not pile up: it stays one toast and its time starts over", () => {
  const { notifier, clock, toasts } = setUp();

  notifier.notify("Offline");
  clock.advance(4000);
  notifier.notify("Offline");
  clock.advance(4000);

  assert.equal(toasts().length, 1);
  assert.equal(toasts()[0].classList.contains("is-leaving"), false, "6 s from the second message, not the first");
  clock.advance(2000);
  assert.equal(toasts()[0].classList.contains("is-leaving"), true);
});

test("at most four toasts show at once: a fifth makes the oldest leave", () => {
  const { notifier, clock, toasts } = setUp();

  for (const word of ["one", "two", "three", "four", "five"]) notifier.notify(word, { timeout: 0 });
  clock.advance(LEAVE_MS);

  assert.deepEqual(toasts().map((toast) => toast.querySelector(".toast-text")?.textContent), ["two", "three", "four", "five"]);
});

test("a toast can carry one action, such as Retry, and acting dismisses it", () => {
  const { notifier, clock, toasts } = setUp();
  let retried = 0;
  notifier.notify("The catalog could not be loaded", { kind: "error", action: { label: "Retry", run: () => (retried += 1) } });

  const buttons = toasts()[0].querySelectorAll("button");
  assert.deepEqual(buttons.map((button) => button.textContent), ["Retry", "Dismiss"]);
  buttons[0].click();

  assert.equal(retried, 1);
  clock.advance(LEAVE_MS);
  assert.equal(toasts().length, 0);
});

test("notify returns a handle that dismisses the toast, and dismissing twice is harmless", () => {
  const { notifier, clock, toasts } = setUp();
  const handle = notifier.notify("Loading Korobeiniki…");

  handle?.dismiss();
  handle?.dismiss();
  clock.advance(LEAVE_MS);

  assert.equal(toasts().length, 0);
  assert.equal(clock.pending(), 0, "no timer is left behind");
});

test("an empty message shows nothing and returns no handle", () => {
  const { notifier, toasts } = setUp();

  assert.equal(notifier.notify(""), null);
  assert.equal(toasts().length, 0);
});

test("without a region (a page without the toast area, a test) notify is a quiet no-op", () => {
  const notifier = createNotifier({ region: null });

  assert.equal(notifier.notify("anyone there?"), null);
  assert.equal(notify("anyone there?"), null, "the shared notify has no document in Node either");
});

test("the status relay shows each line as a toast, replacing the one before it", () => {
  const { notifier, clock, toasts } = setUp();
  const relay = createStatusRelay(notifier);

  relay("Loading Korobeiniki…");
  relay("Korobeiniki: ready to arrange.");
  clock.advance(LEAVE_MS);

  assert.deepEqual(toasts().map((toast) => toast.querySelector(".toast-text")?.textContent), ["Korobeiniki: ready to arrange."]);
});

test("the status relay keeps errors as errors, and an empty line takes the last toast away", () => {
  const { notifier, clock, toasts } = setUp();
  const relay = createStatusRelay(notifier);

  relay("bad.mid: the MIDI header is too short", true);
  assert.equal(toasts()[0].classList.contains("error"), true);
  relay("");
  clock.advance(LEAVE_MS);

  assert.equal(toasts().length, 0);
});
