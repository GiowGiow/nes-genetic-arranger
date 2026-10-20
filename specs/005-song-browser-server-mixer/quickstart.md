# Quickstart: validate spec 005

```bash
cd arranger && node --test
```

```bash
uv run pytest
```

1. Mixer: serve the repo (`python3 -m http.server 8000` at the root), open
   `http://localhost:8000/arranger/`, arrange Korobeiniki, play, move each slider: the channel
   changes at once; switch to Game Boy: levels hold; reload: levels kept; download Audio (WAV).
2. Preview: load a MIDI example, press ▶ on a track that enters late: sound within 1 s.
3. Catalog commands (contracts/cli.md) regenerate `arranger/data/catalog/*.json` and
   `data/catalog/abc/` with no diff (`git status` clean).
4. Server: `uv run --group server server/app.py` (port 8765); in the app set the server URL to
   localhost (the app uses localhost automatically when served from localhost); open an MPB song:
   it loads as a lead sheet; search "waltz": external results arrive; stop the server: the app
   says the server is offline and local cards still work.
5. Browser: arrow to a song and Enter in ≤ 4 keys; 375 px width fits; turn off WebGL
   (`chrome://flags` or a context-loss test hook `?no-webgl`) to see the 2D grid; reduced motion
   stops the animation.
6. Deploy (after the student's OK): `curl https://nes-arranger-bh.giow.dev/health`; CORS preflight
   from `https://giowgiow.github.io`; `/files` refuses private addresses.
