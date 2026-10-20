# Basic Pitch 1.0.1 with TensorFlow.js 3.21.0 (vendored)

Apache-2.0. It turns the audio of a recording into notes, on the visitor's device (spec 007, audio
import). `src/ui/audio-import.js` loads it only when an audio file is opened, so the page does
not pay for it otherwise. No audio leaves the device.

| File | What it is |
|---|---|
| `basic-pitch.js` | One ES module made with esbuild 0.25.12 from `@spotify/basic-pitch` 1.0.1 and the parts of TensorFlow.js 3.21.0 it needs (core, converter, CPU and WebGL backends). 852,578 bytes. Exports `BasicPitch`, `outputToNotesPoly`, `noteFramesToTime`, `addPitchBendsToNoteEvents` and `tf`. |
| `model.json`, `group1-shard1of1.bin` | The model, copied unchanged from `@spotify/basic-pitch/model/` (graph model, converted with TensorFlow.js Converter 3.13.0). 174,537 and 742,392 bytes. |
| `LICENSE` | Apache License 2.0, from the `@spotify/basic-pitch` package. TensorFlow.js is Apache-2.0 too (Copyright 2018 Google LLC). |
| `build-entry.js`, `build-tf-lite.js` | The two small files the bundle was made from (see below). |

SHA-256:

| File | SHA-256 |
|---|---|
| `basic-pitch.js` | `99d66f0aece607cba43e0299ae5934e62e5ed0f577b7e727f210761d4ec9ed1b` |
| `model.json` | `1ed1aaee3409ec1dc098c8b01f430c0911f6fe9412e7af8086750f9e8f302f68` |
| `group1-shard1of1.bin` | `b142a95737a52e1e412d5f92e73d8bb80dfe8d04941acc0702f11f4524fb377c` |

## How the bundle was made

In an empty folder, with `build-entry.js` and `build-tf-lite.js` saved as `entry.js` and `tf-lite.js`:

```bash
npm init -y
npm i @spotify/basic-pitch@1.0.1 esbuild@0.25.12
npx esbuild entry.js --bundle --format=esm --platform=browser --minify --target=es2020 \
  --alias:@tensorflow/tfjs=./tf-lite.js --outfile=basic-pitch.js --legal-comments=none
```

`tf-lite.js` stands in for the full `@tensorflow/tfjs` package: it keeps the core, the graph-model
loader, the CPU and WebGL backends and the chained tensor methods, and leaves out the layers, data
and gradient code that Basic Pitch does not use (the bundle is 0.85 MB instead of about 3 MB).

## How it is used

- The page imports `basic-pitch.js` and gives `BasicPitch` the model's address
  (`tf.loadGraphModel(".../model.json")`). It tries the WebGL backend and falls back to the CPU.
- `tests/basic-pitch.test.js` runs the same file in Node, with the model read from disk, on a
  synthetic tune. The bundle picks its browser platform code when `process` is not defined, so the
  test hides `process` while it imports the file.
- The Node tests never load it otherwise, and the service worker caches it when it is first fetched.
