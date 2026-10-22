// @ts-check
// Tests for ui/downloaded-file.js: how the page asks for a song the visitor downloaded by hand.
//
// A browser never lets a page read the Downloads folder, so the visitor always confirms the file
// in a dialog. Chrome and Edge can open that dialog in the Downloads folder (File System Access
// API, `showOpenFilePicker` with `startIn: "downloads"`); Firefox and Safari only have the
// ordinary file input. The choice between them is a pure function, and a cancelled dialog is not
// an error.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DOWNLOAD_PICKER_OPTIONS,
  downloadStartedMessage,
  looksLikeDownload,
  openDownloadedFile,
  pickerKind,
} from "../src/ui/downloaded-file.js";

/** A file input that counts clicks. */
function fakeInput() {
  return { clicks: 0, click() { this.clicks++; } };
}

/**
 * A window whose picker returns the given handles, or throws the given error.
 * @param {{handles?: Array<{getFile: () => Promise<unknown>}>, error?: Error}} behavior
 */
function windowWithPicker({ handles = [], error } = {}) {
  /** @type {unknown[]} */
  const asked = [];
  return {
    asked,
    showOpenFilePicker: async (/** @type {unknown} */ options) => {
      asked.push(options);
      if (error) throw error;
      return handles;
    },
  };
}

const aFile = { name: "Aquarela.mid" };

test("a browser with showOpenFilePicker gets the native picker; any other gets the file input", () => {
  assert.equal(pickerKind(windowWithPicker()), "native");
  assert.equal(pickerKind({}), "input", "Firefox and Safari");
  assert.equal(pickerKind(/** @type {any} */ ({ showOpenFilePicker: true })), "input", "a flag is not a function");
  assert.equal(pickerKind(undefined), "input", "no window at all");
});

test("the native picker opens in the Downloads folder and lists MIDI and ABC files", () => {
  assert.equal(DOWNLOAD_PICKER_OPTIONS.startIn, "downloads");
  assert.equal(DOWNLOAD_PICKER_OPTIONS.multiple, false);
  const [type] = DOWNLOAD_PICKER_OPTIONS.types;
  assert.deepEqual(type.accept["audio/midi"], [".mid", ".midi"]);
  assert.deepEqual(type.accept["text/plain"], [".abc"]);
  assert.ok(type.description);
});

test("the file chosen in the native picker goes to onFile, and the file input is left alone", async () => {
  const win = windowWithPicker({ handles: [{ getFile: async () => aFile }] });
  const input = fakeInput();
  /** @type {unknown[]} */
  const opened = [];
  const how = await openDownloadedFile({ win, fileInput: input, onFile: (file) => opened.push(file) });
  assert.equal(how, "picker");
  assert.deepEqual(opened, [aFile]);
  assert.deepEqual(win.asked, [DOWNLOAD_PICKER_OPTIONS]);
  assert.equal(input.clicks, 0);
});

test("a picker the visitor cancels is not an error: nothing opens and nothing else pops up", async () => {
  const cancelled = Object.assign(new Error("The user aborted a request."), { name: "AbortError" });
  const win = windowWithPicker({ error: cancelled });
  const input = fakeInput();
  let opened = 0;
  const how = await openDownloadedFile({ win, fileInput: input, onFile: () => opened++ });
  assert.equal(how, "cancelled");
  assert.equal(opened, 0);
  assert.equal(input.clicks, 0, "the file input does not open after a cancel");
});

test("without the native picker the hidden file input opens, and its own change event reads the file", async () => {
  const input = fakeInput();
  let opened = 0;
  const how = await openDownloadedFile({ win: {}, fileInput: input, onFile: () => opened++ });
  assert.equal(how, "input");
  assert.equal(input.clicks, 1);
  assert.equal(opened, 0, "the input panel reads the file when the input changes");
});

test("a native picker that fails for another reason falls back to the file input", async () => {
  const blocked = Object.assign(new Error("not allowed"), { name: "SecurityError" });
  const input = fakeInput();
  const how = await openDownloadedFile({ win: windowWithPicker({ error: blocked }), fileInput: input, onFile: () => {} });
  assert.equal(how, "input");
  assert.equal(input.clicks, 1);
});

test("a picker that returns no file opens nothing", async () => {
  const input = fakeInput();
  let opened = 0;
  const how = await openDownloadedFile({ win: windowWithPicker({ handles: [] }), fileInput: input, onFile: () => opened++ });
  assert.equal(how, "cancelled");
  assert.equal(opened, 0);
});

test("a file name matches the download it came from, whatever the browser did to it", () => {
  const expected = "Águas de Março.mid";
  assert.equal(looksLikeDownload("Águas de Março.mid", expected), true);
  assert.equal(looksLikeDownload("águas de março.MID", expected), true, "case");
  assert.equal(looksLikeDownload("Águas de Março (1).mid", expected), true, "the browser's copy suffix");
  assert.equal(looksLikeDownload("Águas de Março.midi", expected), true, "the other MIDI extension");
  assert.equal(looksLikeDownload("Another song.mid", expected), false);
  assert.equal(looksLikeDownload("Águas de Março remix.mid", expected), false);
});

test("the message after a download names the file, and promises the Downloads folder only where the browser can open it", () => {
  const native = downloadStartedMessage("Aquarela.mid", windowWithPicker());
  assert.match(native, /Aquarela\.mid/);
  assert.match(native, /Open downloaded file/);
  assert.match(native, /Downloads folder/);
  const other = downloadStartedMessage("Aquarela.mid", {});
  assert.match(other, /Aquarela\.mid/);
  assert.match(other, /Open downloaded file/);
  assert.doesNotMatch(other, /Downloads folder/);
});
