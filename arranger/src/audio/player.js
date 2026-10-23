// @ts-check
/**
 * Player: plays the rendered arrangement and the original together, so A/B keeps the position,
 * and mixes the arrangement's four channels while it plays.
 *
 * Both versions are rendered beforehand into sample buffers on the same beat timeline
 * (`chip-synth.js`, `plain-synth.js`, `sound-packs.js`), so beat b sounds at the same second in
 * both. Playing starts one Web Audio source per buffer at the same instant. Each version ends in
 * its own switch gain: the version you hear has gain 1, the other gain 0. Switching only moves
 * the two gains over 80 ms, a crossfade, so the music never restarts or jumps (spec 002, FR-022). A seek
 * restarts every source at the new offset, because a Web Audio source plays only once.
 *
 * The arrangement may come as one buffer or as four stems, one per channel (P1 melody, P2
 * harmony, TR bass, NO drums), so the visitor can set each channel's level while it plays
 * (spec 005, `mixer.js`). The graph is built once per AudioContext; only the sources are new on
 * each play or seek:
 *
 *   P1, P2, TR, NO stems -> channel gains -> bus -> limiter -> arrangement switch -+
 *   original ------------------------------------------------> original switch ----+-> master -> speakers
 *
 * - A level change ramps one channel gain over 10 ms, like the A/B switch: no click, no restart.
 * - The bus gain (`busScale`) matches the mix with the original in loudness (`matchMixLoudness`),
 *   so the levels move away from a fair A/B.
 * - The limiter, a compressor with a hard knee and a high ratio, holds the peaks near -1 dBFS
 *   when the visitor boosts every channel, instead of letting the sum clip (research R2).
 * - The master gain is the volume control (`volumeToGain`): it comes after both versions, so the
 *   original is as loud as the arrangement, and it ramps like every other gain.
 *
 * Every source that is stopped is also disconnected, and a load drops the buffers of the song
 * before it, so a long visit holds one song's sound in memory, not every song played.
 *
 * This is the only module that touches Web Audio (constitution, "Web App Constraints": audio
 * stays at the edges).
 */

import { CHANNELS, DEFAULT_LEVELS, DEFAULT_VOLUME, channelGains, clampLevels, clampVolume, volumeToGain } from "./mixer.js";

/** Gain ramp of an A/B switch or a level change, in seconds: long enough to avoid a click, short enough to feel instant. */
const RAMP_SECONDS = 0.01;

/**
 * Crossfade of an A/B switch, in seconds. A 10 ms ramp is click-free but sounds like a cut; 80 ms
 * is heard as one version dissolving into the other, and still short enough to feel instant. The
 * two versions are the same music on the same timeline, so the fade has no phasing to speak of.
 */
const SWITCH_RAMP_SECONDS = 0.08;

/** Samples the meters read from each channel: 256 is a few milliseconds, enough for a steady RMS. */
const METER_BLOCK = 256;

/** The limiter after the bus (research R2): it acts only on peaks above -1 dBFS, and acts fast. */
const LIMITER = Object.freeze({ threshold: -1, knee: 0, ratio: 20, attack: 0.003, release: 0.1 });

/**
 * What the player asks of the browser when it makes the AudioContext. `"playback"` trades
 * latency for stability: the browser mixes in bigger buffers, so a busy main thread (a phone
 * drawing the playhead, a GC pause) is less likely to leave the sound with a gap. The player
 * plays pre-rendered music and has no live instrument, so a few tens of milliseconds more
 * latency only delay the first sound after a click. The bigger buffers also mean the speakers
 * play a sample later than the context computes it, which `heardTime` corrects for the view.
 */
export const CONTEXT_OPTIONS = Object.freeze({ latencyHint: /** @type {const} */ ("playback") });

/**
 * The context time of the sound coming out of the speakers now.
 *
 * `context.currentTime` is the time of the samples being computed, ahead of the ear by the
 * output latency: the browser's buffers, the system mixer, a Bluetooth link (often 0.1 to 0.3 s,
 * more with `latencyHint: "playback"`). It also moves in jumps of one buffer. The browser's
 * output timestamp says which context time was at the speakers at a moment of the wall clock;
 * moving it on by the wall clock since then gives a smooth, heard time. Without a usable
 * timestamp, the reported latencies are subtracted instead.
 *
 * @param {{currentTime: number, outputLatency?: number, baseLatency?: number,
 *   getOutputTimestamp?: () => {contextTime?: number, performanceTime?: number}}} context
 * @param {number} nowMs `performance.now()`
 * @returns {number} seconds of context time, never ahead of `currentTime` and never below 0
 * @example
 * heardTime({ currentTime: 3, outputLatency: 0.2 }, performance.now()); // 2.8
 */
export function heardTime(context, nowMs) {
  const stamp = context.getOutputTimestamp?.();
  let heard;
  if (stamp?.contextTime && stamp.performanceTime) {
    heard = stamp.contextTime + (nowMs - stamp.performanceTime) / 1000;
  } else {
    heard = context.currentTime - (context.outputLatency ?? 0) - (context.baseLatency ?? 0);
  }
  return Math.max(0, Math.min(context.currentTime, heard));
}

/** @typedef {"arrangement" | "original"} Version */
/** @typedef {import("./chip-synth.js").ChannelName} ChannelName */
/** @typedef {import("./mixer.js").Levels} Levels */

/**
 * The arrangement's four channels, as `renderPackStems` gives them (the pack's balance included).
 * @typedef {Record<ChannelName, Float32Array>} Stems
 */

/**
 * The fixed part of the graph, built once per AudioContext.
 * @typedef {object} MixGraph
 * @property {Record<ChannelName, GainNode>} channels one gain per stem, set by the levels
 * @property {GainNode} bus adds the channels, at gain `busScale`
 * @property {Record<Version, GainNode>} switches the A/B gains, 1 for the version you hear
 * @property {GainNode} master the volume control: both switches end in it, and it feeds the speakers
 * @property {Record<ChannelName, AnalyserNode>} analysers one listener after each channel gain, for the mixer's meters
 */

/**
 * One buffer to play, and the node its source feeds.
 * @typedef {{buffer: AudioBuffer, version: Version, input: AudioNode}} Track
 */

/**
 * Create a player. The AudioContext is created by `ensureContext`, which must run inside a
 * click or key handler: browsers keep audio silent until the visitor interacts with the page.
 *
 * @param {{createContext?: () => AudioContext}} [options] `createContext` makes the context
 *   (default `new AudioContext(CONTEXT_OPTIONS)`; the tests pass a fake one)
 * @returns {{
 *   ensureContext: () => AudioContext,
 *   output: () => AudioNode,
 *   load: (
 *     buffers: {arrangement?: Float32Array | Stems, original?: Float32Array},
 *     sampleRate: number,
 *     options?: {busScale?: number, show?: Version},
 *   ) => void,
 *   unload: () => void,
 *   play: () => void, pause: () => void, toggle: () => void,
 *   seek: (seconds: number) => void, switchTo: (version: Version) => void,
 *   setLevels: (levels: Levels) => void, setBusScale: (scale: number) => void,
 *   setVolume: (percent: number) => void,
 *   currentTime: () => number, duration: () => number, isPlaying: () => boolean,
 *   channelLevels: () => Record<ChannelName, number> | null,
 *   active: () => Version, has: (version: Version) => boolean,
 *   onChange: (listener: () => void) => void,
 * }}
 * @example
 * const player = createPlayer();
 * player.load({ arrangement: renderPackStems("nes", arrangement, rate), original }, rate, { busScale });
 * player.play();
 * player.setLevels({ ...DEFAULT_LEVELS, muted: { P1: false, P2: false, TR: false, NO: true } }); // drums off
 */
export function createPlayer({ createContext = () => new AudioContext({ ...CONTEXT_OPTIONS }) } = {}) {
  /** @type {AudioContext | null} */
  let context = null;
  /** @type {MixGraph | null} */
  let graph = null;
  /** @type {Track[]} */
  let tracks = [];
  /** @type {AudioBufferSourceNode[]} */
  let sources = [];
  /** @type {Version} */
  let active = "arrangement";
  /** @type {Levels} */
  let levels = clampLevels(DEFAULT_LEVELS);
  let busScale = 1;
  /** The master volume in percent; the visitor's choice is kept across loads. */
  let volume = DEFAULT_VOLUME;
  let offset = 0;
  let startedAt = 0;
  let playing = false;
  /** @type {Array<() => void>} */
  const listeners = [];
  const notify = () => listeners.forEach((listener) => listener());

  function ensureContext() {
    if (!context) {
      context = createContext();
      graph = buildGraph(context);
    }
    if (context.state === "suspended") context.resume();
    return context;
  }

  /**
   * @param {AudioContext} audio
   * @returns {MixGraph}
   */
  function buildGraph(audio) {
    const master = audio.createGain();
    master.gain.value = volumeToGain(volume);
    master.connect(audio.destination);
    const switches = { arrangement: audio.createGain(), original: audio.createGain() };
    for (const version of /** @type {Version[]} */ (["arrangement", "original"])) {
      switches[version].gain.value = version === active ? 1 : 0;
      switches[version].connect(master);
    }
    const limiter = audio.createDynamicsCompressor();
    limiter.threshold.value = LIMITER.threshold;
    limiter.knee.value = LIMITER.knee;
    limiter.ratio.value = LIMITER.ratio;
    limiter.attack.value = LIMITER.attack;
    limiter.release.value = LIMITER.release;
    limiter.connect(switches.arrangement);
    const bus = audio.createGain();
    bus.gain.value = busScale;
    bus.connect(limiter);
    const gains = channelGains(levels);
    const channels = /** @type {Record<ChannelName, GainNode>} */ ({});
    const analysers = /** @type {Record<ChannelName, AnalyserNode>} */ ({});
    for (const channel of CHANNELS) {
      channels[channel] = audio.createGain();
      channels[channel].gain.value = gains[channel];
      channels[channel].connect(bus);
      // A listener after the fader: the meter shows what the channel contributes at its level,
      // so a muted channel reads silent. An analyser costs nothing until it is read.
      analysers[channel] = audio.createAnalyser();
      analysers[channel].fftSize = METER_BLOCK;
      channels[channel].connect(analysers[channel]);
    }
    return { channels, bus, switches, master, analysers };
  }

  /**
   * Move a gain to `target` over RAMP_SECONDS, from wherever it is now.
   * @param {AudioParam} param
   * @param {number} target
   * @param {number} [seconds]
   */
  function rampTo(param, target, seconds = RAMP_SECONDS) {
    if (!context) return;
    const now = context.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(target, now + seconds);
  }

  function rampSwitches() {
    if (!graph) return;
    rampTo(graph.switches.arrangement.gain, active === "arrangement" ? 1 : 0, SWITCH_RAMP_SECONDS);
    rampTo(graph.switches.original.gain, active === "original" ? 1 : 0, SWITCH_RAMP_SECONDS);
  }

  /** @param {Version} version */
  const has = (version) => tracks.some((track) => track.version === version);

  function duration() {
    return Math.max(0, ...tracks.map((track) => track.buffer.duration));
  }

  function currentTime() {
    if (!playing || !context) return offset;
    // The position heard, not the one computed (see `heardTime`). The sources start 20 ms after
    // the click and the speakers lag behind, so the first moments are before the start: clamp at 0.
    const heard = heardTime(context, performance.now());
    return Math.max(0, Math.min(duration(), offset + heard - startedAt));
  }

  /** The block the meters read into; one array for all four analysers, since they are read in turn. */
  const meterBlock = new Float32Array(METER_BLOCK);

  /**
   * The level of each channel now, as the linear RMS (0 to 1) of what comes out of its fader.
   * Read only when called: the mixer's meters call it once per animation frame, and only while
   * they are on screen and the music plays.
   *
   * @returns {Record<ChannelName, number> | null} null while nothing plays
   */
  function channelLevels() {
    if (!playing || !graph) return null;
    const levels = /** @type {Record<ChannelName, number>} */ ({});
    for (const channel of CHANNELS) {
      graph.analysers[channel].getFloatTimeDomainData(meterBlock);
      let sum = 0;
      for (let i = 0; i < meterBlock.length; i++) sum += meterBlock[i] * meterBlock[i];
      levels[channel] = Math.sqrt(sum / meterBlock.length);
    }
    return levels;
  }

  function stopSources() {
    for (const source of sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // A source that never started cannot stop; nothing to undo.
      }
      // A stopped source cannot play again; cutting it from the graph lets the browser free it.
      source.disconnect();
    }
    sources = [];
  }

  function startSources() {
    const audio = ensureContext();
    stopSources();
    startedAt = audio.currentTime + 0.02;
    for (const { buffer, input } of tracks) {
      const source = audio.createBufferSource();
      source.buffer = buffer;
      source.connect(input);
      if (offset < buffer.duration) source.start(startedAt, offset);
      sources.push(source);
    }
    const longest = sources.reduce(
      (best, source) => ((source.buffer?.duration ?? 0) > (best?.buffer?.duration ?? 0) ? source : best),
      sources[0],
    );
    if (longest) {
      longest.onended = () => {
        if (!playing) return;
        playing = false;
        offset = 0;
        stopSources();
        notify();
      };
    }
  }

  return {
    ensureContext,
    output() {
      ensureContext();
      return /** @type {MixGraph} */ (graph).master;
    },
    load(newBuffers, sampleRate, options = {}) {
      const audio = ensureContext();
      const mix = /** @type {MixGraph} */ (graph);
      const wasPlaying = playing;
      if (playing) this.pause();
      tracks = [];
      /**
       * @param {Float32Array | undefined} samples
       * @param {Version} version
       * @param {AudioNode} input
       */
      const addTrack = (samples, version, input) => {
        if (!samples || samples.length === 0) return;
        const buffer = audio.createBuffer(1, samples.length, sampleRate);
        buffer.copyToChannel(samples, 0);
        tracks.push({ buffer, version, input });
      };
      const { arrangement, original } = newBuffers;
      // One buffer is already mixed: it skips the channel gains and goes straight to the bus.
      if (ArrayBuffer.isView(arrangement)) addTrack(arrangement, "arrangement", mix.bus);
      else if (arrangement) for (const channel of CHANNELS) addTrack(arrangement[channel], "arrangement", mix.channels[channel]);
      addTrack(original, "original", mix.switches.original);
      busScale = options.busScale ?? 1;
      rampTo(mix.bus.gain, busScale);
      // A new arrangement is heard first, and so is nothing else: `show` names the version, a
      // plain load keeps the one heard (a change of sound pack goes on in the same version).
      if (options.show && has(options.show)) active = options.show;
      if (!has(active)) active = has("arrangement") || !has("original") ? "arrangement" : "original";
      rampSwitches();
      offset = Math.min(offset, duration());
      if (wasPlaying) this.play();
      notify();
    },
    unload() {
      playing = false;
      stopSources();
      tracks = [];
      offset = 0;
      notify();
    },
    play() {
      if (playing || duration() === 0) return;
      if (offset >= duration()) offset = 0;
      startSources();
      playing = true;
      notify();
    },
    pause() {
      if (!playing) return;
      offset = currentTime();
      playing = false;
      stopSources();
      notify();
    },
    toggle() {
      if (playing) this.pause();
      else this.play();
    },
    seek(seconds) {
      offset = Math.max(0, Math.min(duration(), seconds));
      if (playing) startSources();
      notify();
    },
    switchTo(version) {
      if (!has(version)) return;
      active = version;
      rampSwitches();
      notify();
    },
    setLevels(newLevels) {
      levels = clampLevels(newLevels);
      if (!graph) return;
      const gains = channelGains(levels);
      for (const channel of CHANNELS) rampTo(graph.channels[channel].gain, gains[channel]);
    },
    setVolume(percent) {
      volume = clampVolume(percent);
      if (graph) rampTo(graph.master.gain, volumeToGain(volume));
    },
    setBusScale(scale) {
      busScale = scale;
      if (graph) rampTo(graph.bus.gain, busScale);
    },
    currentTime,
    duration,
    channelLevels,
    isPlaying: () => playing,
    active: () => active,
    has,
    onChange(listener) {
      listeners.push(listener);
    },
  };
}
