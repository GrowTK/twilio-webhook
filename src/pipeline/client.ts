import axios from 'axios';
import { execSync } from 'child_process';
import { config } from '../config';
import { buildWav } from '../audio/wav';

export interface PipelineResponse {
  audio: string; // base64-encoded mulaw 8kHz audio
}

/**
 * Convert MP3 buffer to mulaw 8kHz mono using ffmpeg.
 */
function mp3ToMulaw(mp3Buffer: Buffer): Buffer {
  return execSync(
    'ffmpeg -i pipe:0 -f mulaw -ar 8000 -ac 1 -loglevel error pipe:1',
    { input: mp3Buffer, maxBuffer: 10 * 1024 * 1024 }
  );
}

export async function sendToPipeline(
  audioSamples: Int16Array,
  callSid: string
): Promise<PipelineResponse> {
  if (!config.pipeline.url) {
    throw new Error('VOICE_PIPELINE_URL is not configured');
  }

  // Send as WAV so Deepgram can decode the audio
  const wavBuffer = buildWav(audioSamples, 8000);
  const audioBase64 = wavBuffer.toString('base64');

  console.log(`[Pipeline] Sending ${audioSamples.length} samples (${wavBuffer.length} bytes WAV) for call ${callSid}`);

  const response = await axios.post(
    config.pipeline.url,
    { audio: audioBase64 },
    {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.pipeline.apiKey,
      },
      timeout: 30000,
      responseType: 'arraybuffer',
    }
  );

  const responseBuffer = Buffer.from(response.data);
  console.log(`[Pipeline] Response: ${response.status}, ${responseBuffer.length} bytes, first4=[${responseBuffer.slice(0, 4).toString('hex')}]`);

  if (responseBuffer.length < 100) {
    // Too small to be real audio — might be an error message
    const text = responseBuffer.toString('utf8');
    console.error(`[Pipeline] Unexpected small response: ${text}`);
    return { audio: '' };
  }

  // Pipeline returns MP3 — convert to mulaw for Twilio
  try {
    const mulawBuffer = mp3ToMulaw(responseBuffer);
    console.log(`[Pipeline] Converted MP3 → mulaw: ${mulawBuffer.length} bytes (${(mulawBuffer.length / 8000).toFixed(1)}s)`);
    return { audio: mulawBuffer.toString('base64') };
  } catch (err: any) {
    console.error(`[Pipeline] ffmpeg conversion failed:`, err?.message);
    return { audio: '' };
  }
}
