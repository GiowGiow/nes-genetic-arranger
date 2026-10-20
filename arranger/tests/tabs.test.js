// @ts-check
// Tests for ui/tabs.js: the page shows one screen per tab, and the tab lives in the URL hash.

import assert from "node:assert/strict";
import { test } from "node:test";

import { TABS, stepTab, tabFromHash, tabForPanel } from "../src/ui/tabs.js";

test("the four tabs come in the order of a run: song, evolution, result, then how it works", () => {
  assert.deepEqual(
    TABS.map((tab) => [tab.id, tab.label]),
    [
      ["song", "Song"],
      ["evolution", "Evolution"],
      ["result", "Result"],
      ["how", "How it works"],
    ],
  );
});

test("the Song tab holds the song, the run and the settings cards", () => {
  assert.deepEqual(TABS[0].panels, ["song", "run", "settings"]);
});

test("the hash names the tab, and an unknown or empty hash opens the Song tab", () => {
  assert.equal(tabFromHash("#evolution"), "evolution");
  assert.equal(tabFromHash("#how"), "how");
  assert.equal(tabFromHash(""), "song");
  assert.equal(tabFromHash("#nowhere"), "song");
});

test("an old link to a card opens the tab that holds it", () => {
  assert.equal(tabFromHash("#run"), "song");
  assert.equal(tabFromHash("#settings"), "song");
  assert.equal(tabFromHash("#about"), "how");
  assert.equal(tabForPanel("result"), "result");
  assert.equal(tabForPanel("nowhere"), null);
});

test("arrow keys move to the next or previous tab and wrap around; Home and End jump to the ends", () => {
  assert.equal(stepTab(0, "ArrowRight", 4), 1);
  assert.equal(stepTab(3, "ArrowRight", 4), 0);
  assert.equal(stepTab(0, "ArrowLeft", 4), 3);
  assert.equal(stepTab(2, "Home", 4), 0);
  assert.equal(stepTab(1, "End", 4), 3);
  assert.equal(stepTab(1, "Enter", 4), null);
});
