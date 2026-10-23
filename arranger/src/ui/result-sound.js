// @ts-check
/**
 * Result sound: what the Result panel's player holds, and when it changes.
 *
 * The player (`audio/player.js`) holds the sound of one song at a time: the arrangement's four
 * stems and the original, or just the original while a song is only previewed. Four events change
 * what it holds, and each one has to leave the player and the toggle telling the truth about what
 * will play:
 *
 * - a run ends or is brought back (`showRun`): both versions are loaded, the run's sound is
 *   rendered if it was released, and the sound of every other run is freed;
 * - Preview of a song that has no run on screen (`showIntro`): the player is emptied of the old
 *   song, and only the preview's original is loaded, so the arrangement button has nothing to
 *   switch to;
 * - Preview of the song whose run is on screen (`replayOriginal`): the run's own original plays
 *   from the start, and the arrangement stays one click away;
 * - a new song is loaded (`forget`): the player is emptied, so Play cannot play the last song.
 *
 * Without these rules, a preview after a run could leave the old arrangement loaded or the toggle
 * on a version that is not the one playing, and every run kept its 100 MB of buffers.
 *
 * Rendering a pack's sound is slow (a second for most packs, ten for the Mega Drive on a long
 * song), so the page asks a worker (`showRunAsync`, with the renderer of `audio-renderer.js`):
 * - a run that has just ended empties the player at once, so Play cannot play the last run's
 *   sound while the new one renders;
 * - a change of sound pack keeps the old pack playing until the new one is ready, then swaps it
 *   in place (the player keeps the position, the play state and the version heard);
 * - every call takes a ticket, and a render that finishes after a newer call began is thrown
 *   away, so choosing Plain and then Chip quickly ends with Chip, not with whichever finished last.
 */

import { createAudioRenderer } from "../audio/audio-renderer.js";
import { renderRunAudio } from "../audio/run-audio.js";
import { releaseAudio } from "./run-list.js";

/**
 * @param {{
 *   player: ReturnType<typeof import("../audio/player.js").createPlayer>,
 *   runs: () => import("./run-list.js").RunEntry[],
 *   renderer?: {renderRun: (run: any, soundPack: string, sampleRate: number, kept: import("../audio/run-audio.js").RunAudio | null) => Promise<import("../audio/run-audio.js").RunAudio>},
 * }} parts the page's player, the run list as it is now, and the renderer for `showRunAsync`
 * @returns {{
 *   showRun: (run: any, soundPack: string, sampleRate: number, options: {fresh: boolean}) => import("../audio/run-audio.js").RunAudio,
 *   showRunAsync: (run: any, soundPack: string, sampleRate: number, options: {fresh: boolean}) => Promise<import("../audio/run-audio.js").RunAudio | null>,
 *   showIntro: (samples: Float32Array, sampleRate: number) => void,
 *   replayOriginal: () => boolean,
 *   forget: () => void,
 * }}
 * @example
 * const sound = createResultSound({ player, runs: () => state.runs });
 * sound.showRun(run, "nes", context.sampleRate, { fresh: true }); // a run just ended
 */
export function createResultSound({ player, runs, renderer = createAudioRenderer() }) {
  let ticket = 0;
  return {
    /**
     * Load a run's sound, rendering it first if it was released.
     *
     * @param {any} run an entry of the run list, with its notes
     * @param {string} soundPack
     * @param {number} sampleRate
     * @param {{fresh: boolean}} options `fresh`: the run has just ended or been picked, so the
     *   arrangement is heard first; otherwise the version being heard stays (a change of sound pack)
     * @returns {import("../audio/run-audio.js").RunAudio} the run's audio, for the WAV download
     */
    showRun(run, soundPack, sampleRate, { fresh }) {
      ticket += 1;
      // Free the others first: the new render must not sit next to the old one's 100 MB.
      releaseAudio(runs(), run.id);
      run.audio = renderRunAudio(run, soundPack, sampleRate, run.audio);
      const { stems, originalSamples, busScale, sampleRate: rate } = run.audio;
      player.load({ arrangement: stems, original: originalSamples }, rate, { busScale, show: fresh ? "arrangement" : undefined });
      return run.audio;
    },

    /**
     * Load a run's sound, rendered off the page's thread.
     *
     * @param {any} run
     * @param {string} soundPack
     * @param {number} sampleRate
     * @param {{fresh: boolean}} options as for `showRun`
     * @returns {Promise<import("../audio/run-audio.js").RunAudio | null>} the run's audio; null
     *   when a newer call replaced this one while it rendered
     * @throws {Error} when the render fails; the player keeps what it had
     * @example
     * const audio = await sound.showRunAsync(run, "megadrive", rate, { fresh: false }); // the old pack plays meanwhile
     */
    async showRunAsync(run, soundPack, sampleRate, { fresh }) {
      const mine = ++ticket;
      // Free the other runs' buffers; this run's own stay until the new render replaces them.
      releaseAudio(runs(), run.id);
      if (fresh) {
        player.pause();
        player.unload();
        run.audio = null;
      }
      let audio;
      try {
        audio = await renderer.renderRun(run, soundPack, sampleRate, run.audio);
      } catch (error) {
        if (/** @type {any} */ (error)?.stale) return null;
        throw error;
      }
      if (mine !== ticket) return null;
      run.audio = audio;
      const { stems, originalSamples, busScale, sampleRate: rate } = audio;
      player.load({ arrangement: stems, original: originalSamples }, rate, { busScale, show: fresh ? "arrangement" : undefined });
      return audio;
    },

    /**
     * Load only a preview's original, in place of whatever the player held.
     *
     * @param {Float32Array} samples the preview, loudness matched
     * @param {number} sampleRate
     */
    showIntro(samples, sampleRate) {
      ticket += 1; // a render still going belongs to the song this replaces
      player.pause();
      releaseAudio(runs(), null);
      player.unload();
      player.load({ original: samples }, sampleRate);
      player.seek(0);
    },

    /**
     * Play the original of the run on screen from its start.
     *
     * @returns {boolean} false when no original is loaded
     */
    replayOriginal() {
      if (!player.has("original")) return false;
      player.switchTo("original");
      player.seek(0);
      if (!player.isPlaying()) player.play();
      return true;
    },

    /** Stop the music and empty the player: a new song is loaded, and nothing of the last one may play. */
    forget() {
      ticket += 1;
      player.unload();
      releaseAudio(runs(), null);
    },
  };
}
