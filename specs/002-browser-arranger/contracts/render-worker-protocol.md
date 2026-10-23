# Contract: Page ↔ Render Worker

The sound of a run is rendered by a second module worker (`arranger/src/audio/render-worker.js`,
created with `{type: "module"}` by `audio-renderer.js`), so choosing a sound pack or finishing a
run never freezes the page. The brain of the worker is `render-service.js`, a pure function from a
request to a reply plus the list of buffers to transfer (not copy). Without Web Workers, or when
the browser refuses to start one, the page runs the same service itself.

## Page → worker

### `run`

```json
{
  "type": "run", "id": 3,
  "run": { "id": "korobeiniki-s1-3fa2c901", "arrangement": { "...": "assemble(), notes in beats" },
           "voices": { "...": "the original's notes, in beats" }, "tempoBpm": 150, "durationBeats": 128 },
  "pack": "snes", "sampleRate": 48000
}
```

Renders the four stems of the arrangement in the sound pack and the original, matched in loudness
(`renderRunAudio`). The worker keeps the original's plain render of the last run it served, which
does not depend on the pack, so a change of pack renders the stems only.

### `original`

```json
{ "type": "original", "id": 4, "voices": { "...": "notes in beats" }, "tempoBpm": 150, "sampleRate": 48000, "beats": 32 }
```

Renders only the original, loudness matched, for a song's preview.

## Worker → page

```json
{ "type": "done", "id": 3, "audio": { "pack": "snes", "sampleRate": 48000,
  "stems": { "P1": "Float32Array", "P2": "Float32Array", "TR": "Float32Array", "NO": "Float32Array" },
  "busScale": 0.83, "originalRaw": null, "originalSamples": "Float32Array" } }
{ "type": "done", "id": 4, "samples": "Float32Array" }
{ "type": "error", "id": 3, "message": "…" }
```

The arrays' buffers are transferred, and each belongs to one array alone. `originalRaw` is always
`null` from the worker: the plain render stays there.

## Rules

- A request that the page replaces (another pack, another run, a preview) is stale. The page cannot
  interrupt a render in progress, so it terminates the worker and starts a new one for the new
  request; the stale request ends with an error whose `stale` is true, which callers ignore.
- The page keeps the old pack playing until the new one is ready (`result-sound.js`,
  `showRunAsync`), and loads only the render of the newest request.
- The worker loads no network resource and posts nothing but these messages.
