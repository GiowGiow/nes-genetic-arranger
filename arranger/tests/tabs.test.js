// @ts-check
// Tests for ui/tabs.js: the page shows one screen per tab, and the tab lives in the URL hash.

import assert from "node:assert/strict";
import { test } from "node:test";

import { TABS, VIEWS, hashFor, routeFromHash, stepTab, tabFromHash, tabForPanel } from "../src/ui/tabs.js";

test("the three tabs come in the order of a visit: song, run (the evolution and the result), then how it works", () => {
  assert.deepEqual(
    TABS.map((tab) => [tab.id, tab.label]),
    [
      ["song", "Song"],
      ["evolution", "Run"],
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

test("the Evolution tab has two views, the evolution and the result, each with the full width", () => {
  assert.deepEqual(
    VIEWS.map((view) => [view.id, view.label]),
    [
      ["evolution", "Evolution"],
      ["result", "Result"],
    ],
  );
});

test("the hash names the view too: #result opens the Evolution tab on its Result view, #evolution on its Evolution view", () => {
  assert.deepEqual(routeFromHash("#result"), { tab: "evolution", view: "result" });
  assert.deepEqual(routeFromHash("#evolution"), { tab: "evolution", view: "evolution" });
  assert.deepEqual(routeFromHash("result"), { tab: "evolution", view: "result" }, "the # is optional");
});

test("an old link to the workbench opens the Evolution view; links to other tabs name no view, so the view stays as it was", () => {
  assert.deepEqual(routeFromHash("#workbench"), { tab: "evolution", view: "evolution" });
  assert.deepEqual(routeFromHash("#mix"), { tab: "evolution", view: null });
  assert.deepEqual(routeFromHash("#song"), { tab: "song", view: null });
  assert.deepEqual(routeFromHash("#about"), { tab: "how", view: null });
  assert.deepEqual(routeFromHash("#run"), { tab: "song", view: null });
  assert.deepEqual(routeFromHash(""), { tab: "song", view: null });
  assert.deepEqual(routeFromHash("#nowhere"), { tab: "song", view: null });
});

test("the hash to write is the view's name on the Evolution tab and the tab's name elsewhere", () => {
  assert.equal(hashFor("evolution", "result"), "#result");
  assert.equal(hashFor("evolution", "evolution"), "#evolution");
  assert.equal(hashFor("song", "result"), "#song", "the view is kept in memory, not in the hash, off the Evolution tab");
  assert.equal(hashFor("how", "evolution"), "#how");
});

test("a hash written for a view reads back as the same tab and view", () => {
  for (const tab of TABS) {
    for (const view of VIEWS) {
      const route = routeFromHash(hashFor(tab.id, view.id));
      assert.equal(route.tab, tab.id);
      if (tab.id === "evolution") assert.equal(route.view, view.id);
    }
  }
});

test("the two view tabs follow the same arrow keys as the page tabs", () => {
  assert.equal(stepTab(0, "ArrowRight", VIEWS.length), 1);
  assert.equal(stepTab(1, "ArrowRight", VIEWS.length), 0);
  assert.equal(stepTab(0, "End", VIEWS.length), 1);
});

// ---- The wiring: a change of tab or view goes through the transitioner ----

import { setUpPageTabs } from "../src/ui/tabs.js";
import { FakeDocument } from "./fake-dom.js";

/** The page shell for `setUpPageTabs`: sections by id, tab buttons, and a transitioner that records. */
function tabsPage() {
  const document = new FakeDocument();
  /** @type {Record<string, any>} */
  const sections = {};
  for (const id of ["song", "settings", "workbench", "mix", "how", "evolution", "result"]) sections[id] = document.createElement("section");
  const makeNav = (/** @type {string} */ attribute, /** @type {string[]} */ ids) => {
    const nav = document.createElement("nav");
    const buttons = ids.map((id) => {
      const button = document.createElement("button");
      button.dataset = { [attribute]: id };
      return button;
    });
    nav.querySelectorAll = () => /** @type {any} */ (buttons);
    return { nav, buttons };
  };
  const tabs = makeNav("tab", ["song", "evolution", "how"]);
  const views = makeNav("view", ["evolution", "result"]);
  /** @type {Array<{direction: string | undefined}>} */
  const runs = [];
  const real = { document: globalThis.document, location: globalThis.location, history: globalThis.history, addEventListener: globalThis.addEventListener };
  Object.assign(globalThis, {
    document: { getElementById: (/** @type {string} */ id) => sections[id] ?? null },
    location: { hash: "" },
    history: { replaceState() {} },
    addEventListener() {},
  });
  const changes = /** @type {string[]} */ ([]);
  const api = setUpPageTabs(/** @type {any} */ (tabs.nav), {
    viewNav: /** @type {any} */ (views.nav),
    onChange: (id) => changes.push(id),
    transitions: {
      run(update, direction) {
        runs.push({ direction });
        update();
      },
    },
  });
  return {
    api, sections, tabs, views, runs, changes,
    restore() {
      Object.assign(globalThis, real);
    },
  };
}

test("opening a tab changes the sections inside a transition that slides toward the new tab", () => {
  const page = tabsPage();
  try {
    page.runs.length = 0;
    page.api.show("how");

    assert.equal(page.runs.at(-1)?.direction, "forward");
    assert.equal(page.sections.how.hidden, false);
    assert.equal(page.sections.song.hidden, true);
    assert.equal(page.changes.at(-1), "how");

    page.api.show("song");
    assert.equal(page.runs.at(-1)?.direction, "back");
  } finally {
    page.restore();
  }
});

test("the tab buttons answer at once: the selection does not wait for the transition", () => {
  const page = tabsPage();
  try {
    page.api.show("evolution");
    assert.equal(page.tabs.buttons[1].getAttribute("aria-selected"), "true");
    assert.equal(page.tabs.buttons[0].getAttribute("aria-selected"), "false");
  } finally {
    page.restore();
  }
});

test("switching to the Result view slides forward and back to the Evolution view slides back", () => {
  const page = tabsPage();
  try {
    page.runs.length = 0;
    page.api.showView("result");
    assert.equal(page.runs.at(-1)?.direction, "forward");
    assert.equal(page.sections.result.hidden, false);
    assert.equal(page.sections.evolution.hidden, true);
    page.api.showView("evolution");
    assert.equal(page.runs.at(-1)?.direction, "back");
  } finally {
    page.restore();
  }
});

test("the first screen, read from the hash, appears at once: there is nothing to dissolve from", () => {
  const page = tabsPage();
  try {
    assert.equal(page.runs.length, 0, "no transition for the initial tab and view");
    assert.equal(page.sections.song.hidden, false);
    assert.equal(page.sections.how.hidden, true);
    assert.deepEqual(page.changes, ["song"]);
  } finally {
    page.restore();
  }
});
