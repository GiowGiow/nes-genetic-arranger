// @ts-check
// Tests for ui/result-evolving.js: what the Result says while a new run evolves (audit L20). The
// previous run's scores, lines and downloads must not stay next to a run that has not finished;
// the Result shows a plain "evolving" state with the live progress, and the previous run's
// fitness as a reminder of what the new run has to beat.

import assert from "node:assert/strict";
import { test } from "node:test";

import { describeEvolving } from "../src/ui/result-evolving.js";

test("before the first generation arrives it says the run is starting", () => {
  assert.deepEqual(describeEvolving({ last: null, maxGenerations: 4000, previousFitness: null }), {
    title: "Evolving a new arrangement…",
    detail: "Starting the evolution…",
    previous: "",
  });
});

test("with a generation reported it names the generation out of the maximum and the best fitness so far", () => {
  const view = describeEvolving({
    last: { generation: 120, best: 0.87321, mean: 0.8, diversity: 0.9, stagnation: 3 },
    maxGenerations: 4000,
    previousFitness: null,
  });

  assert.equal(view.detail, "Generation 120 of 4,000 · best fitness 0.8732");
});

test("the previous run's fitness is kept as a reminder, with four decimals", () => {
  const view = describeEvolving({ last: null, maxGenerations: 4000, previousFitness: 0.90861 });

  assert.equal(view.previous, "Previous run: fitness 0.9086");
});
