# three.js 0.186.1 (vendored)

MIT. It draws the catalog's 3D vinyl records (spec 005, research R6).

| Field | Value |
|---|---|
| Package | `three` |
| Version | 0.186.1 |
| npm tarball | https://registry.npmjs.org/three/-/three-0.186.1.tgz (source of `LICENSE`) |
| `three.module.min.js` | https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.min.js, unchanged |
| SHA-256 | `3bc833fceb6577bd1a380388f832ae61cd6e2f78ad02b0bf0d5adf5a4a9334fe` (392,831 bytes) |
| `three.core.js` | https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.core.min.js, saved as `three.core.js` |
| SHA-256 | `3b346151f65ffdfca3e4c002bd58966b78c423087fb48a873f83200de1bffc48` (415,816 bytes) |
| License | `LICENSE` from the npm package (MIT, three.js authors) |

## Why these two files

- The npm package ships no minified builds since r170. These two files are jsDelivr's minified
  copies of the package's `build/three.module.js` and `build/three.core.js`.
- The module file imports `./three.core.js` by that exact name, so the minified core is saved
  under the unminified name.

## How it is used

- `index.html` maps `three` to `vendor/three/three.module.min.js` with an import map.
- Only `src/ui/shelf-scene.js` imports it, and only when WebGL is available. The Node tests
  never load it.
