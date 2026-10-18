// The frame a custom theme runs in: Halo's state and voice, the ask line's
// draft and the clock, then the theme itself. A theme that throws shows its
// error here (and tells Halo) instead of a blank window.

import '../styles/halo.css';

import Theme from '@theme';
import { Component, type ReactNode, StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { clock, useHalo, useStillWhenAway } from '../lib/useHalo';
import { useVoice } from '../lib/useVoice';
import { themeReady } from './api';

class Catch extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    window.parent.postMessage({ halo: 1, t: 'error', message: `${error.message}\n${error.stack ?? ''}`.slice(0, 4000) }, '*');
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 40, color: '#ffb4a0', fontFamily: 'ui-monospace, monospace', whiteSpace: 'pre-wrap', fontSize: 13 }}>
        This theme stopped with an error:{'\n\n'}
        {this.state.error.message}
      </div>
    );
  }
}

function Shell() {
  useStillWhenAway();
  const halo = useHalo();
  const [draft, setDraft] = useState('');
  const [now, setNow] = useState(clock());
  const voice = useVoice((text, sent) => {
    if (!sent) setDraft((d) => (d.trim() ? `${d.trim()} ${text}` : text));
  });
  useEffect(() => {
    const t = setInterval(() => setNow(clock()), 15_000);
    return () => clearInterval(t);
  }, []);
  return <Theme halo={halo} voice={voice} draft={draft} setDraft={setDraft} now={now} switcher={null} />;
}

document.body.classList.add('sky-body');
createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Catch>
      <Shell />
    </Catch>
  </StrictMode>,
);
themeReady();
