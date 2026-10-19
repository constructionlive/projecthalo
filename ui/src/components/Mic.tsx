// The mic: tap to talk into the ask line, tap again to stop. The ring swells
// with your voice; dots while the words are worked out.

import type { Voice } from '../lib/useVoice';
import { SUMMON_KEY } from '../lib/keys';

export function Mic({ voice }: { voice: Voice }) {
  const s = voice.status;
  const rec = !!s?.recording;
  const busy = !!s?.transcribing;
  const off = !s || s.state !== 'ready';
  const label = off
    ? s?.state === 'loading'
      ? 'Voice is loading…'
      : (s?.error ?? 'No speech model: open LiveType once to download one')
    : rec
      ? 'Stop and use what I said'
      : `Talk (or hold ${SUMMON_KEY} anywhere)`;
  return (
    <button type="button" className={`icon-btn mic${rec ? ' rec' : ''}${busy ? ' busy' : ''}`} onClick={voice.toggle} aria-label={label} title={label} disabled={off && !rec}>
      <span className="mic-ring" aria-hidden style={{ transform: `scale(${1 + voice.level * 0.9})` }} />
      {busy ? (
        <span className="mono" aria-hidden style={{ fontSize: 11, letterSpacing: '0.2em' }}>···</span>
      ) : (
        <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
        </svg>
      )}
    </button>
  );
}
