// @ts-check
// Tests for ui/generation-strip.js: "one generation, step by step". The strip states the real
// steps of the GA with the real numbers of the run (core/evolution.js, core/operators.js), so the
// numbers are computed from the settings and checked here against the arithmetic of the method.

import assert from "node:assert/strict";
import { test } from "node:test";

import { CRITERIA } from "../src/core/fitness.js";
import { describeGeneration, stepsMarkup } from "../src/ui/generation-strip.js";

const run = {
  populationSize: 60,
  eliteCount: 2,
  mutationRate: 0.01,
  nBars: 32,
  applicable: { contrast: true, coherence: true, bass_smoothness: true },
};

test("a generation has five steps, in the order the GA does them", () => {
  const steps = describeGeneration(run, null);

  assert.deepEqual(steps.map((step) => step.id), ["score", "elite", "select", "crossover", "mutate"]);
  assert.deepEqual(steps.map((step) => step.number), [1, 2, 3, 4, 5]);
});

test("scoring: every plan is scored on every applicable criterion, and the total is counted from the run", () => {
  const first = describeGeneration(run, null).find((step) => step.id === "score");
  assert.ok(first);
  assert.match(first.text, /60 plans/);
  assert.match(first.text, /7 criteria/);

  const later = describeGeneration(run, { generation: 99, best: 0.9, mean: 0.8, diversity: 0.5, stagnation: 4 }).find((step) => step.id === "score");
  assert.deepEqual(later?.live.find((item) => item.label === "plans scored")?.value, "6,000");
});

test("a criterion that cannot apply to the song is left out of the count", () => {
  const flat = { ...run, applicable: { contrast: false, coherence: false, bass_smoothness: true } };
  const step = describeGeneration(flat, null).find((entry) => entry.id === "score");

  assert.match(step?.text ?? "", /5 criteria/);
  assert.equal(CRITERIA.length - 2, 5);
});

test("elitism: the best plans pass to the next generation unchanged", () => {
  const step = describeGeneration(run, { generation: 5, best: 0.8732, mean: 0.7, diversity: 0.9, stagnation: 0 }).find((entry) => entry.id === "elite");

  assert.match(step?.text ?? "", /best 2 of 60/);
  assert.deepEqual(step?.live, [{ label: "best fitness", value: "0.8732" }]);
});

test("roulette: the children's parents are picked in proportion to fitness, two per pair of children", () => {
  const step = describeGeneration(run, { generation: 5, best: 0.87, mean: 0.8012, diversity: 0.93, stagnation: 0 }).find((entry) => entry.id === "select");

  assert.match(step?.text ?? "", /58 children/);
  assert.match(step?.text ?? "", /58 parents/, "29 pairs of children need 58 picks");
  assert.deepEqual(step?.live, [
    { label: "population mean", value: "0.8012" },
    { label: "distinct plans", value: "93%" },
  ]);
});

test("an odd number of free places still picks a parent pair for the last child", () => {
  const odd = describeGeneration({ ...run, eliteCount: 1 }, null).find((entry) => entry.id === "select");
  assert.match(odd?.text ?? "", /59 children/);
  assert.match(odd?.text ?? "", /60 parents/, "30 pairs, the last pair's second child is dropped");
});

test("one-point crossover cuts every pair at one of the bar lines of the song", () => {
  const step = describeGeneration(run, null).find((entry) => entry.id === "crossover");

  assert.match(step?.text ?? "", /29 pairs/);
  assert.match(step?.text ?? "", /31 bar lines/);
});

test("a song of one bar has no bar line to cut at, so crossover only copies", () => {
  const step = describeGeneration({ ...run, nBars: 1 }, null).find((entry) => entry.id === "crossover");
  assert.match(step?.text ?? "", /no bar line/);
});

test("mutation: each of the four genes of a bar changes with the rate, which is about 4 bars in 100 at a gene rate of 1 percent", () => {
  const step = describeGeneration(run, null).find((entry) => entry.id === "mutate");

  assert.match(step?.text ?? "", /1% per gene/);
  assert.match(step?.text ?? "", /3\.9% per bar/, "1 - 0.99^4");
  assert.deepEqual(step?.live, [{ label: "genes changed per generation", value: "about 74" }], "58 children x 128 genes x 1%");
});

test("the stagnation count is shown where it matters, on the elite step: it is why a run stops", () => {
  const step = describeGeneration(run, { generation: 300, best: 0.9, mean: 0.8, diversity: 0.2, stagnation: 120 }).find((entry) => entry.id === "elite");
  assert.deepEqual(step?.live.find((item) => item.label === "without improvement")?.value, "120");
});

test("the markup is an ordered list of five steps with the live numbers marked, and no emoji", () => {
  const markup = stepsMarkup(describeGeneration(run, null));

  assert.match(markup, /^<ol class="gen-steps"/);
  assert.equal(markup.match(/<li class="gen-step"/g)?.length, 5);
  assert.match(markup, /data-live="select"/);
  assert.doesNotMatch(markup, /\p{Extended_Pictographic}/u);
});
