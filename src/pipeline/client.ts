import axios from 'axios';
import { config } from '../config';
import { buildWav } from '../audio/wav';

export interface PipelineResponse {
  audio: string;
  contentType?: string;
}

export async function sendToPipeline(
  audioSamples: Int16Array,
  callSid: string
): Promise<PipelineResponse> {
  if (!config.pipeline.url) {
    throw new Error('VOICE_PIPELINE_URL is not configured');
  }

  // Send as WAV so Deepgram can properly decode the audio
  const wavBuffer = buildWav(audioSamples, 8000);
  const audioBase64 = wavBuffer.toString('base64');

  console.log(`[Pipeline] Sending ${audioSamples.length} samples (${wavBuffer.length} bytes WAV) for call ${callSid}`);

  const response = await axios.post<PipelineResponse>(
    config.pipeline.url,
    { audio: audioBase64 },
    {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.pipeline.apiKey,
      },
      timeout: config.pipeline.timeoutMs,
    }
  );

  console.log(`[Pipeline] Response status: ${response.status}, has audio: ${!!response.data?.audio}`);
  return response.data;
}
