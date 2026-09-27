// src/ipc/chat-ipc-handlers.ts
import { ipcMain } from 'electron';
import { log } from '../core/logger';
import { getJarvisCore } from '../core/jarvis-core';
import { getSecureApiService } from '../services/secure-api-service';
import { CH, wrap } from './ipc-types';
import { emitToAll } from './ipc-handlers';

interface ChatSendPayload {
  conversationId: string;
  message: string;
  /** Optional context (transcript, active app) */
  context?: Record<string, unknown>;
}

let currentRequestId: string | null = null;
let currentAbort: AbortController | null = null;

export function registerChatIpcHandlers(): void {
  ipcMain.handle(CH.chatSend, (_e, payload: ChatSendPayload) =>
    wrap(async () => {
      const core = getJarvisCore();
      core.setState('thinking', 'chat-send');

      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      currentRequestId = requestId;
      currentAbort = new AbortController();

      const api = getSecureApiService();

      try {
        // Streaming chat via SSE-style endpoint
        const response = await fetch(`${apiOrigin()}/chat/stream`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${api.getAccessToken() ?? ''}`,
          },
          body: JSON.stringify(payload),
          signal: currentAbort.signal,
        });

        if (!response.ok || !response.body) {
          throw new Error(`chat HTTP ${response.status}`);
        }

        core.setState('responding', 'chat-stream');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) continue;
            const data = trimmed.slice(5).trim();
            if (data === '[DONE]') continue;

            try {
              const chunk = JSON.parse(data) as { text?: string; token?: string };
              const text = chunk.text ?? chunk.token ?? '';
              if (text) emitToAll(CH.chatChunk, { requestId, text });
            } catch {
              /* ignore malformed chunks */
            }
          }
        }

        emitToAll(CH.chatDone, { requestId });
        core.setState('idle', 'chat-done');
        return { requestId };
      } catch (err) {
        if ((err as { name?: string }).name === 'AbortError') {
          emitToAll(CH.chatDone, { requestId, aborted: true });
          core.setState('idle', 'chat-aborted');
          return { requestId, aborted: true };
        }
        core.setState('error', 'chat-failed');
        throw err;
      } finally {
        if (currentRequestId === requestId) {
          currentRequestId = null;
          currentAbort = null;
        }
      }
    })
  );

  ipcMain.handle(CH.chatCancel, () =>
    wrap(() => {
      currentAbort?.abort();
      return { cancelled: true };
    })
  );

  log.ipc.debug('chat IPC ready');
}

function apiOrigin(): string {
  return process.env.JARVIS_API_ORIGIN ?? 'https://api.example.com';
}
