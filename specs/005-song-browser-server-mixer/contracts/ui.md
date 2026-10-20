# Contract: song browser and mixer UI

- Song card: `#song-browser` (canvas + DOM listbox), search box `input[type=search]`, insert-disc
  button, hidden file input. Drop anywhere on `#song` still loads a file.
- Keyboard: ←/→/↑/↓ move, Home/End, Enter opens (card → songs → details), Escape goes back, `/`
  focuses search. Details actions: Arrange, Preview, Song page.
- Status line under the browser announces loading, server offline, and errors (`aria-live`).
- Result card: `[data-mixer]` with four `input[type=range]` (P1, P2, TR "Bass", NO "Drums"), each
  with a mute toggle, and Reset; downloads gain "Audio (WAV)".
