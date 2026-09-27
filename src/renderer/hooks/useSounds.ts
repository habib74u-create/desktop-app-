// src/renderer/hooks/useSounds.ts
import { useCallback, useMemo } from 'react';
import confettiPop from '../assets/sounds/confetti-pop.mp3';
// import recordingStart from '../assets/sounds/recording-start.mp3';
// import recordingStop from '../assets/sounds/recording-stop.mp3';
// import error from '../assets/sounds/error.mp3';
// import notification from '../assets/sounds/notification.mp3';

const SOUNDS = {
  'confetti-pop': confettiPop,
  // 'recording-start': recordingStart,
  // 'recording-stop': recordingStop,
  // error,
  // notification,
} as const;

export type SoundName = keyof typeof SOUNDS;

export function useSounds() {
  const cache = useMemo(() => {
    const map = new Map<SoundName, HTMLAudioElement>();
    for (const [name, url] of Object.entries(SOUNDS) as Array<[SoundName, string]>) {
      const el = new Audio(url);
      el.preload = 'auto';
      el.volume = 0.7;
      map.set(name, el);
    }
    return map;
  }, []);

  const play = useCallback(
    (name: SoundName, volume = 0.7) => {
      const base = cache.get(name);
      if (!base) return;
      // Clone so overlapping plays work
      const el = base.cloneNode() as HTMLAudioElement;
      el.volume = volume;
      void el.play().catch(() => {
        // Autoplay policies may block; ignore
      });
    },
    [cache]
  );

  return { play };
}
