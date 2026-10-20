// @ts-check
// Tests for ui/tabs.js: the page shows one screen per tab, and the tab lives in the URL hash.

import assert from "node:assert/strict";
import { test } from "node:test";

import { TABS, stepTab, tabFromHash, tabForPanel } from "../src/ui/tabs.js";

test("the three tabs come in the order of a visit: song, evolution (with the result), then how it works", () => {
  assert.deepEqual(
    TABS.map((tab) => [tab.id, tab.label]),
    [
      ["song", "Song"],
      ["evolution", "Evolution"],
      ["how", "How it works"],
    ],
  );
});

test("the Evolution tab holds the workbench (run bar, evolution and result) and the mixer; the settings drawer opens from it and from Song", () => {
  assert.deepEqual(TABS[0].panels, ["song", "settings"]);
  assert.deepEqual(TABS[1].panels, ["workbench", "settings", "mix"]);
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
  assert.equal(tabFromHash("#result"), "evolution", "the result is on the Evolution tab now");
  assert.equal(tabForPanel("result"), "evolution");
  assert.equal(tabForPanel("workbench"), "evolution");
  assert.equal(tabForPanel("nowhere"), null);
});

test("arrow keys move to the next or previous tab and wrap around; Home and End jump to the ends", () => {
  assert.equal(stepTab(0, "ArrowRight", 3), 1);
  assert.equal(stepTab(2, "ArrowRight", 3), 0);
  assert.equal(stepTab(0, "ArrowLeft", 3), 2);
  assert.equal(stepTab(2, "Home", 3), 0);
  assert.equal(stepTab(1, "End", 3), 2);
  assert.equal(stepTab(1, "Enter", 3), null);
});
