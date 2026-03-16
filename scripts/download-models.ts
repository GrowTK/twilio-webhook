// Downloads the Silero VAD v5 ONNX model from the official snakers4/silero-vad release
// Run via: tsx scripts/download-models.ts
// Also executed automatically during Docker build via `npm run postbuild`

import https from 'https';
import fs from 'fs';
import path from 'path';

const MODEL_URL =
  'https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx';

const MODELS_DIR = path.join(process.cwd(), 'models');
const MODEL_PATH = path.join(MODELS_DIR, 'silero_vad.onnx');

async function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest)) {
      console.log(`[download-models] Model already exists at ${dest}, skipping download.`);
      resolve();
      return;
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });

    const file = fs.createWriteStream(dest);
    console.log(`[download-models] Downloading Silero VAD model from:\n  ${url}`);

    function get(currentUrl: string): void {
      https.get(currentUrl, (response) => {
        // Follow redirects (GitHub raw URLs redirect)
        if (
          response.statusCode === 301 ||
          response.statusCode === 302 ||
          response.statusCode === 307 ||
          response.statusCode === 308
        ) {
          const location = response.headers.location;
          if (!location) {
            reject(new Error('Redirect with no Location header'));
            return;
          }
          console.log(`[download-models] Redirecting to: ${location}`);
          get(location);
          return;
        }

        if (response.statusCode !== 200) {
          reject(
            new Error(
              `Failed to download model: HTTP ${response.statusCode} from ${currentUrl}`
            )
          );
          return;
        }

        const total = parseInt(response.headers['content-length'] ?? '0', 10);
        let received = 0;

        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (total > 0) {
            const pct = ((received / total) * 100).toFixed(1);
            process.stdout.write(`\r[download-models] Progress: ${pct}% (${received}/${total} bytes)`);
          }
        });

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          process.stdout.write('\n');
          console.log(`[download-models] Model saved to: ${dest}`);
          resolve();
        });
      }).on('error', (err) => {
        fs.unlink(dest, () => {}); // Clean up partial file
        reject(err);
      });
    }

    get(url);
  });
}

(async () => {
  try {
    await downloadFile(MODEL_URL, MODEL_PATH);
    console.log('[download-models] Done.');
  } catch (err) {
    console.error('[download-models] Error:', err);
    process.exit(1);
  }
})();
