// @ts-check
/**
 * Result while evolving: what the Result panel shows during a new run.
 *
 * Until now the Result kept the last run's scores, lines and downloads, with Play enabled, next to
 * a run that had not finished, so it looked as if the new run's result were already there. While a
 * run evolves, the Result shows one clear state instead: a spinning record, "Evolving a new
 * arrangement…", the live generation and best fitness, and the previous run's fitness as the
 * number to beat. When the run ends the real result replaces it.
 */

/**
 * The words of the evolving state.
 *
 * @param {{
 *   last: {generation: number, best: number} | null,
 *   maxGenerations: number,
 *   previousFitness: number | null,
 * }} state `last`: the newest generation reported, null before the first
 * @returns {{title: string, detail: string, previous: string}}
 * @example
 * describeEvolving({ last: { generation: 120, best: 0.8732 }, maxGenerations: 4000, previousFitness: null }).detail;
 * // "Generation 120 of 4,000 · best fitness 0.8732"
 */
export function describeEvolving({ last, maxGenerations, previousFitness }) {
  return {
    title: "Evolving a new arrangement…",
    detail: last
      ? `Generation ${last.generation} of ${maxGenerations.toLocaleString("en-US")} · best fitness ${last.best.toFixed(4)}`
      : "Starting the evolution…",
    previous: previousFitness === null ? "" : `Previous run: fitness ${previousFitness.toFixed(4)}`,
  };
}

/**
 * Build the state's markup inside `container`.
 *
 * @param {HTMLElement} container
 * @returns {{
 *   update: (state: Parameters<typeof describeEvolving>[0]) => void,
 * }}
 */
export function createResultEvolving(container) {
  container.classList.add("result-evolving");
  container.innerHTML =
    `<span class="spinner" aria-hidden="true"></span>` +
    `<div><p class="evolving-title" data-evolving-title></p>` +
    `<p class="evolving-detail mono" data-evolving-detail></p>` +
    `<p class="evolving-previous" data-evolving-previous></p></div>`;
  const title = /** @type {HTMLElement} */ (container.querySelector("[data-evolving-title]"));
  const detail = /** @type {HTMLElement} */ (container.querySelector("[data-evolving-detail]"));
  const previous = /** @type {HTMLElement} */ (container.querySelector("[data-evolving-previous]"));
  return {
    update(state) {
      const view = describeEvolving(state);
      title.textContent = view.title;
      detail.textContent = view.detail;
      previous.textContent = view.previous;
    },
  };
}
