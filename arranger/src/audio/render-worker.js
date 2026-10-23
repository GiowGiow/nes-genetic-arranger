// @ts-check
// The render worker: renders the sound of a run off the page's main thread, so changing the sound
// pack or finishing a run never freezes the page (audit L12, L13). This file only wires the
// worker's message channel to the render service (`render-service.js`), which holds the protocol
// and is tested without a browser. The page creates it with
// `new Worker(new URL("./render-worker.js", import.meta.url), { type: "module" })`
// (`audio-renderer.js`).

import { createRenderService } from "./render-service.js";

/**
 * The parts of the dedicated worker scope used here.
 * @type {{
 *   postMessage: (message: unknown, transfer?: ArrayBuffer[]) => void,
 *   onmessage: ((event: MessageEvent) => void) | null,
 * }}
 */
const scope = /** @type {any} */ (self);

const service = createRenderService();

scope.onmessage = (event) => {
  const { reply, transfer } = service.handle(event.data);
  scope.postMessage(reply, transfer);
};
