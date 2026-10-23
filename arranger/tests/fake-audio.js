// @ts-check
// A fake Web Audio for the tests of the player and of the code around it: nodes that record how
// they are connected and disconnected, gains that record what is scheduled on them, and a
// context that lists every source it made. Node has no Web Audio; these classes are just enough
// of it to read the graph back. Not a test itself: node --test only runs `*.test.js`.

export const RATE = 100;

/** An AudioParam that records what is scheduled on it; `value` follows the last target. */
export class FakeParam {
  /** @param {number} value */
  constructor(value) {
    this.value = value;
    /** @type {Array<[string, ...number[]]>} */
    this.calls = [];
  }
  /** @param {number} value @param {number} time */
  setValueAtTime(value, time) {
    this.calls.push(["set", value, time]);
    this.value = value;
    return this;
  }
  /** @param {number} value @param {number} time */
  linearRampToValueAtTime(value, time) {
    this.calls.push(["ramp", value, time]);
    this.value = value;
    return this;
  }
  /** @param {number} time */
  cancelScheduledValues(time) {
    this.calls.push(["cancel", time]);
    return this;
  }
}

export class FakeNode {
  /** @param {string} kind */
  constructor(kind) {
    this.kind = kind;
    /** @type {FakeNode[]} */
    this.outputs = [];
    /** @type {FakeAnalyser[]} analysers listening to this node: taps, not part of the signal path */
    this.taps = [];
    this.disconnected = false;
  }
  /** @param {FakeNode} node */
  connect(node) {
    // An analyser only listens: it is not a destination of the signal.
    if (node instanceof FakeAnalyser) this.taps.push(node);
    else this.outputs.push(node);
    return node;
  }
  disconnect() {
    this.outputs = [];
    this.disconnected = true;
  }
}

export class FakeGain extends FakeNode {
  constructor() {
    super("gain");
    this.gain = new FakeParam(1);
  }
}

export class FakeCompressor extends FakeNode {
  constructor() {
    super("compressor");
    this.threshold = new FakeParam(-24);
    this.knee = new FakeParam(30);
    this.ratio = new FakeParam(12);
    this.attack = new FakeParam(0.003);
    this.release = new FakeParam(0.25);
  }
}

/** An AnalyserNode: it holds the block of samples the test says is passing now. */
export class FakeAnalyser extends FakeNode {
  constructor() {
    super("analyser");
    this.fftSize = 2048;
    /** @type {number[]} what getFloatTimeDomainData hands out (repeated to fill the block) */
    this.block = [0];
    this.reads = 0;
  }
  /** @param {Float32Array} array */
  getFloatTimeDomainData(array) {
    this.reads += 1;
    for (let i = 0; i < array.length; i++) array[i] = this.block[i % this.block.length];
  }
}

export class FakeBuffer {
  /** @param {number} channels @param {number} length @param {number} sampleRate */
  constructor(channels, length, sampleRate) {
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    /** @type {Float32Array | null} */
    this.samples = null;
  }
  /** @param {Float32Array} samples */
  copyToChannel(samples) {
    this.samples = Float32Array.from(samples);
  }
}

export class FakeSource extends FakeNode {
  constructor() {
    super("source");
    /** @type {FakeBuffer | null} */
    this.buffer = null;
    /** @type {{when: number, offset: number} | null} */
    this.started = null;
    this.stopped = false;
    /** @type {(() => void) | null} */
    this.onended = null;
  }
  /** @param {number} when @param {number} offset */
  start(when, offset) {
    this.started = { when, offset };
  }
  stop() {
    // As in Web Audio, a source that never started cannot stop.
    if (!this.started) throw new Error("InvalidStateError");
    this.stopped = true;
  }
}

export class FakeContext {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = RATE;
    this.state = "running";
    this.destination = new FakeNode("destination");
    /** @type {FakeGain[]} */
    this.gains = [];
    /** @type {FakeSource[]} */
    this.sources = [];
    /** @type {FakeCompressor[]} */
    this.compressors = [];
    /** @type {FakeAnalyser[]} */
    this.analysers = [];
  }
  createAnalyser() {
    const analyser = new FakeAnalyser();
    this.analysers.push(analyser);
    return analyser;
  }
  createGain() {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
  createBufferSource() {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  createDynamicsCompressor() {
    const compressor = new FakeCompressor();
    this.compressors.push(compressor);
    return compressor;
  }
  /** @param {number} channels @param {number} length @param {number} sampleRate */
  createBuffer(channels, length, sampleRate) {
    return new FakeBuffer(channels, length, sampleRate);
  }
  resume() {
    this.state = "running";
  }
}
