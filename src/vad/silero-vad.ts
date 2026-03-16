// Silero VAD v5 ONNX wrapper via onnxruntime-node
// Input: Float32Array, 512 samples @ 16kHz (32ms frame)
// v5 uses a single 'state' tensor [2, 1, 128] instead of separate h/c

import * as ort from 'onnxruntime-node';
import * as path from 'path';

export const SILERO_FRAME_SIZE = 512;
const SAMPLE_RATE = 16000;
const STATE_SIZE = 128;
const NUM_LAYERS = 2;

export interface VADResult {
  probability: number;
}

export class SileroVAD {
  private session: ort.InferenceSession | null = null;
  private state: ort.Tensor;

  constructor() {
    this.state = new ort.Tensor(
      'float32',
      new Float32Array(NUM_LAYERS * 1 * STATE_SIZE),
      [NUM_LAYERS, 1, STATE_SIZE]
    );
  }

  async initialize(): Promise<void> {
    const modelPath = path.join(process.cwd(), 'models', 'silero_vad.onnx');
    this.session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    });
  }

  async processFrame(frame: Float32Array): Promise<VADResult> {
    if (!this.session) {
      throw new Error('SileroVAD not initialized — call initialize() first');
    }

    if (frame.length !== SILERO_FRAME_SIZE) {
      throw new Error(
        `Silero VAD expects exactly ${SILERO_FRAME_SIZE} samples, got ${frame.length}`
      );
    }

    const inputTensor = new ort.Tensor('float32', frame, [1, SILERO_FRAME_SIZE]);
    const srTensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), [1]);

    const results = await this.session.run({
      input: inputTensor,
      sr: srTensor,
      state: this.state,
    });

    // Log output keys on first run to verify model output names
    const keys = Object.keys(results);
    if (keys.length > 0) {
      const outputNames = keys.join(', ');
      const prob = (results[keys[0]]?.data as Float32Array)?.[0];
      console.log(`[VAD] output keys: ${outputNames} | first value: ${prob}`);
    }

    // Update state for next frame — try both 'stateN' and 'hn'
    this.state = (results['stateN'] ?? results['hn'] ?? results[keys[keys.length - 1]]) as ort.Tensor;

    const outputData = (results['output'] ?? results[keys[0]]).data as Float32Array;
    return { probability: outputData[0] };
  }

  resetState(): void {
    this.state = new ort.Tensor(
      'float32',
      new Float32Array(NUM_LAYERS * 1 * STATE_SIZE),
      [NUM_LAYERS, 1, STATE_SIZE]
    );
  }
}
