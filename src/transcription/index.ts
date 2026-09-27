// src/transcription/index.ts
export { LocalWhisperTranscriber, WHISPER_MODELS, type WhisperModelId } from './local-whisper-transcriber';
export { SherpaOnnxTranscriber } from './sherpa-onnx-transcriber';
export { SherpaOnlineTranscriber } from './sherpa-online-transcriber';
export { getSherpaModelManager, initSherpaModelManager, SHERPA_MODELS } from './sherpa-models';

import { LocalWhisperTranscriber } from './local-whisper-transcriber';
import { SherpaOnnxTranscriber } from './sherpa-onnx-transcriber';
import { SherpaOnlineTranscriber } from './sherpa-online-transcriber';
import { getMachineInfo, recommendedWhisperModel } from '../core/machine-arch';
import { getAppSettingsService } from '../services/app-settings-service';
import { log } from '../core/logger';

/**
 * Pick the best engine based on user settings + hardware.
 * Called from main.ts after services are ready.
 */
export function pickTranscriptionEngine() {
  const settings = getAppSettingsService().get();
  const machine = getMachineInfo();

  if (!settings.preferLocal) {
    log.transcription.info('cloud transcription preferred — no local engine loaded');
    return null;
  }

  // If the user chose a Whisper model, use whisper.cpp
  // Otherwise fall back to sherpa (streaming is nice for dictation)
  if (settings.whisperModel) {
    const model = (settings.whisperModel ?? recommendedWhisperModel()) as Parameters<typeof LocalWhisperTranscriber>[0];
    log.transcription.info(`selected whisper.cpp engine (model=${model})`);
    return new LocalWhisperTranscriber(model);
  }

  log.transcription.info('selected sherpa-onnx streaming engine');
  return new SherpaOnlineTranscriber();
}
