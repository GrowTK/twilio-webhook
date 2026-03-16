// Barge-in detector using energy-based VAD
// Detects speech start/end and emits 'utterance-end' when silence exceeds threshold

import { EventEmitter } from 'events';
import { config } from '../config';
import { EnergyVAD } from '../vad/energy-vad';
import { resample8to16, int16ToFloat32 } from '../audio/resampler';

const FRAME_SIZE_8K = 256; // 256 samples @ 8kHz = 32ms
const FRAME_MS = 32;
const SILENCE_FRAMES_FOR_UTTERANCE_END = Math.ceil(config.vad.silenceMs / FRAME_MS);

export class BargeInDetector extends EventEmitter {
  private vad: EnergyVAD;
  private consecutiveVoiceFrames = 0;
  private consecutiveSilenceFrames = 0;
  private hasSpeechStarted = false;
  private cooldownActive = false;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private audioBuffer: Int16Array = new Int16Array(0);

  constructor(_unused1: unknown, _unused2: unknown) {
    super();
    this.vad = new EnergyVAD();
  }

  async feed(samples8k: Int16Array): Promise<void> {
    const combined = new Int16Array(this.audioBuffer.length + samples8k.length);
    combined.set(this.audioBuffer);
    combined.set(samples8k, this.audioBuffer.length);
    this.audioBuffer = combined;

    while (this.audioBuffer.length >= FRAME_SIZE_8K) {
      const frame8k = this.audioBuffer.slice(0, FRAME_SIZE_8K);
      this.audioBuffer = this.audioBuffer.slice(FRAME_SIZE_8K);
      await this.processFrame(frame8k);
    }
  }

  private async processFrame(frame8k: Int16Array): Promise<void> {
    const frame16k = resample8to16(frame8k);
    const floatFrame = int16ToFloat32(frame16k);
    const { probability, isSpeech } = this.vad.processFrame(floatFrame);

    if (isSpeech) {
      this.consecutiveVoiceFrames++;
      this.consecutiveSilenceFrames = 0;

      if (!this.hasSpeechStarted && this.consecutiveVoiceFrames >= 3) {
        this.hasSpeechStarted = true;
        console.log(`[BargeIn] Speech started (prob=${probability.toFixed(3)})`);
        this.emit('speech-start');
      }

      // Barge-in: sustained speech
      const requiredFrames = Math.ceil(config.vad.holdOffMs / FRAME_MS);
      if (this.consecutiveVoiceFrames >= requiredFrames && !this.cooldownActive) {
        this.triggerBargeIn();
      }
    } else {
      this.consecutiveVoiceFrames = 0;
      this.consecutiveSilenceFrames++;

      // After speech was detected, count silence frames for utterance end
      if (this.hasSpeechStarted && this.consecutiveSilenceFrames >= SILENCE_FRAMES_FOR_UTTERANCE_END) {
        console.log(`[BargeIn] Utterance end (${this.consecutiveSilenceFrames} silence frames = ${this.consecutiveSilenceFrames * FRAME_MS}ms)`);
        this.emit('utterance-end');
        this.hasSpeechStarted = false;
      }
    }
  }

  private triggerBargeIn(): void {
    console.log('[BargeIn] Barge-in triggered');
    this.emit('barge-in');
    this.cooldownActive = true;

    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = setTimeout(() => {
      this.cooldownActive = false;
      this.cooldownTimer = null;
    }, config.bargeIn.cooldownMs);
  }

  reset(): void {
    this.consecutiveVoiceFrames = 0;
    this.consecutiveSilenceFrames = 0;
    this.hasSpeechStarted = false;
    this.cooldownActive = false;
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    this.audioBuffer = new Int16Array(0);
    this.vad.resetState();
  }

  destroy(): void {
    this.reset();
    this.removeAllListeners();
  }
}
