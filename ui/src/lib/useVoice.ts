// The mic: LiveType's engine in the app (dictation into the ask line, or
// hold right ⌘ to ask out loud). Follows the engine's status, level and words.

import { useEffect, useState } from 'react';

import { api } from './api';

export interface VoiceStatus {
  state: 'noModel' | 'loading' | 'ready' | 'failed';
  model: string | null;
  error: string | null;
  recording: boolean;
  transcribing: boolean;
}

type VoiceOut = { type: 'status'; status: VoiceStatus } | { type: 'level'; level: number } | { type: 'heard'; text: string; send: boolean };

export interface Voice {
  status: VoiceStatus | null;
  level: number;
  /** Held right ⌘: the panel is listening for a question. */
  holding: boolean;
  toggle: () => void;
}

export function useVoice(onHeard: (text: string, sent: boolean) => void): Voice {
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [level, setLevel] = useState(0);
  const [holding, setHolding] = useState(false);

  useEffect(() => {
    api.voiceStatus().then(setStatus).catch(() => {});
    const off = api.on<VoiceOut>('voice', (o) => {
      if (o.type === 'status') setStatus(o.status);
      else if (o.type === 'level') setLevel(Math.min(1, o.level * 6));
      else onHeard(o.text, o.send);
    });
    const off2 = api.on<boolean>('voice-hold', setHolding);
    return () => {
      off.then((f) => f());
      off2.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!status?.recording) setLevel(0);
  }, [status?.recording]);

  const toggle = () => {
    if (status?.recording) api.voiceStop();
    else api.voiceStart(false);
  };
  return { status, level, holding, toggle };
}
