// The parts of TensorFlow.js that Basic Pitch needs: the core, the graph-model loader, and the CPU
// and WebGL backends.
export * from "@tensorflow/tfjs-core";
export { loadGraphModel } from "@tensorflow/tfjs-converter";
import "@tensorflow/tfjs-backend-cpu";
import "@tensorflow/tfjs-backend-webgl";
import "@tensorflow/tfjs-core/dist/public/chained_ops/register_all_chained_ops";
