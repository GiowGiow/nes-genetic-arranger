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
 */

import { renderRunAudio } from "../audio/run-audio.js";
import { releaseAudio } from "./run-list.js";

/**
 * @param {{
 *   player: ReturnType<typeof import("../audio/player.js").createPlayer>,
 *   runs: () => import("./run-list.js").RunEntry[],
 * }} parts the page's player, and the run list as it is now
 * @returns {{
 *   showRun: (run: any, soundPack: string, sampleRate: number, options: {fresh: boolean}) => import("../audio/run-audio.js").RunAudio,
 *   showIntro: (samples: Float32Array, sampleRate: number) => void,
 *   replayOriginal: () => boolean,
 *   forget: () => void,
 * }}
 * @example
 * const sound = createResultSound({ player, runs: () => state.runs });
 * sound.showRun(run, "nes", context.sampleRate, { fresh: true }); // a run just ended
 */
export function createResultSound({ player, runs }) {
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
      // Free the others first: the new render must not sit next to the old one's 100 MB.
      releaseAudio(runs(), run.id);
      run.audio = renderRunAudio(run, soundPack, sampleRate, run.audio);
      const { stems, originalSamples, busScale, sampleRate: rate } = run.audio;
      player.load({ arrangement: stems, original: originalSamples }, rate, { busScale, show: fresh ? "arrangement" : undefined });
      return run.audio;
    },

    /**
     * Load only a preview's original, in place of whatever the player held.
     *
     * @param {Float32Array} samples the preview, loudness matched
     * @param {number} sampleRate
     */
    showIntro(samples, sampleRate) {
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
      player.unload();
      releaseAudio(runs(), null);
    },
  };
}
