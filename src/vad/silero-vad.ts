// Silero VAD v5 ONNX wrapper via onnxruntime-node
// Input: Float32Array, 512 samples @ 16kHz (32ms frame)
// Maintains per-session LSTM state (h, c tensors)

import * as ort from 'onnxruntime-node';
import * as path from 'path';

// Silero VAD v5 processes 512 samples at 16kHz = 32ms per frame
export const SILERO_FRAME_SIZE = 512;
const SAMPLE_RATE = 16000;

// LSTM hidden/cell state dimensions for Silero VAD v5
const H_SIZE = 64;
const NUM_LAYERS = 2;

export interface VADResult {
  probability: number;
}

export class SileroVAD {
  private session: ort.InferenceSession | null = null;
  // LSTM state: shape [2 (num_layers), 1 (batch), 64 (hidden_size)]
  private h: ort.Tensor;
  private c: ort.Tensor;

  constructor() {
    const stateShape = [NUM_LAYERS, 1, H_SIZE];
    this.h = new ort.Tensor('float32', new Float32Array(NUM_LAYERS * H_SIZE), stateShape);
    this.c = new ort.Tensor('float32', new Float32Array(NUM_LAYERS * H_SIZE), stateShape);
  }

  async initialize(): Promise<void> {
    const modelPath = path.join(process.cwd(), 'models', 'silero_vad.onnx');
    this.session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    });
  }

  /**
   * Run VAD inference on a single 512-sample frame at 16kHz.
   * LSTM state is maintained across calls — call resetState() between utterances.
   */
  async processFrame(frame: Float32Array): Promise<VADResult> {
    if (!this.session) {
      throw new Error('SileroVAD not initialized — call initialize() first');
    }

    if (frame.length !== SILERO_FRAME_SIZE) {
      throw new Error(
        `Silero VAD expects exactly ${SILERO_FRAME_SIZE} samples, got ${frame.length}`
      );
    }

    // Input tensor: [1, 512] (batch=1, samples=512)
    const inputTensor = new ort.Tensor('float32', frame, [1, SILERO_FRAME_SIZE]);
    const srTensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), [1]);

    const feeds: Record<string, ort.Tensor> = {
      input: inputTensor,
      sr: srTensor,
      h: this.h,
      c: this.c,
    };

    const results = await this.session.run(feeds);

    // Update LSTM state for next frame
    this.h = results['hn'] as ort.Tensor;
    this.c = results['cn'] as ort.Tensor;

    // Output is a single probability value
    const outputData = results['output'].data as Float32Array;
    const probability = outputData[0];

    return { probability };
  }

  /**
   * Reset LSTM state. Must be called between separate calls/utterances
   * to prevent state bleed from previous audio.
   */
  resetState(): void {
    const stateShape = [NUM_LAYERS, 1, H_SIZE];
    this.h = new ort.Tensor('float32', new Float32Array(NUM_LAYERS * H_SIZE), stateShape);
    this.c = new ort.Tensor('float32', new Float32Array(NUM_LAYERS * H_SIZE), stateShape);
  }
}
