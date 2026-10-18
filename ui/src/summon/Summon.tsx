// The Summon panel: tap right ⌘ from any app. One line to ask (or hold right
// ⌘ and say it), Halo's answer crawling in, and anything waiting on the person.

import { useEffect, useRef, useState } from 'react';

import { Crawl, type CrawlEntry } from '../components/Crawl';
import { Mic } from '../components/Mic';
import { api } from '../lib/api';
import { colorOf, tagOf } from '../lib/stars';
import type { Star } from '../lib/types';
import { useHalo, useHotkey, useStillWhenAway } from '../lib/useHalo';
import { useVoice } from '../lib/useVoice';

function Waiting({ star }: { star: Star }) {
  const [answer, setAnswer] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const t = answer.trim();
        if (t) api.tell(star.id, t).then(() => setAnswer(''));
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 8, borderLeft: '2px solid var(--signal)', paddingLeft: 14 }}
    >
      <span className="mono" style={{ fontSize: 9, color: 'var(--signal)' }}>{star.title} <span className="sep">/</span> waiting on you</span>
      <span style={{ fontSize: 16, lineHeight: 1.45 }}>{star.question ?? star.now}</span>
      <div className="answer" style={{ marginTop: 2 }}>
        <label className="sr" htmlFor={`sa-${star.id}`}>Answer {star.title}</label>
        <input id={`sa-${star.id}`} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Answer…" />
        <button className="btn signal" type="submit" disabled={!answer.trim()}>Reply</button>
      </div>
    </form>
  );
}

/** Bars that follow the voice level while listening. */
function Meter({ level }: { level: number }) {
  return (
    <div aria-hidden style={{ display: 'flex', alignItems: 'center', gap: 3, height: 34 }}>
      {Array.from({ length: 24 }, (_, i) => {
        const shape = 0.35 + 0.65 * Math.abs(Math.sin(i * 1.7 + level * 9));
        return <span key={i} style={{ width: 3, height: Math.max(3, level * 34 * shape), background: 'var(--star)', borderRadius: 2, transition: 'height 90ms linear', opacity: 0.85 }} />;
      })}
    </div>
  );
}

export function Summon() {
  useStillWhenAway();
  const halo = useHalo();
  const hk = useHotkey();
  const { state, stars } = halo;
  const [draft, setDraft] = useState('');
  // When the person last asked here: the reply area shows from then on.
  const [askedAt, setAskedAt] = useState<number | null>(null);
  const [heard, setHeard] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const voice = useVoice((text, sent) => {
    if (sent) {
      setHeard(text);
      setAskedAt(Date.now() - 1000);
    } else setDraft((d) => (d.trim() ? `${d.trim()} ${text}` : text));
  });

  // The window is exactly as tall as the panel, so it never blocks clicks below.
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const ro = new ResizeObserver(() => api.fitSummon(Math.ceil(el.getBoundingClientRect().height) + 44));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const focus = () => {
      setAskedAt(null);
      setHeard(null);
      halo.refresh();
      setTimeout(() => input.current?.focus(), 30);
    };
    focus();
    const off = api.on('summon-shown', focus);
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape') api.hideSummon();
      if (e.key === 'Enter' && e.metaKey) api.openSky();
    };
    window.addEventListener('keydown', keys);
    return () => {
      off.then((f) => f());
      window.removeEventListener('keydown', keys);
    };
  }, []);

  const waiting = stars.filter((s) => s.status === 'needsYou');
  const active = stars.filter((s) => s.status === 'working' || s.status === 'forming');
  const recent = stars.filter((s) => s.status === 'landed').sort((a, b) => b.updated - a.updated).slice(0, 2);
  const chips = [...waiting, ...active, ...recent].slice(0, 6);
  const listening = voice.holding || !!voice.status?.recording;

  // The reply: from what was asked here on, crawling in.
  const since = askedAt ?? Infinity;
  const entries: CrawlEntry[] = state.lines.filter((l) => l.ts >= since).map((l, i) => ({ key: `${l.ts}-${i}`, role: l.role, text: l.text }));
  if (halo.chunks.length && askedAt !== null) entries.push({ key: 'live', role: 'halo', text: halo.live, chunks: halo.chunks });
  const replying = askedAt !== null;
  const thinking = replying && (state.busy || entries.every((e) => e.role !== 'halo')) && !halo.chunks.length;

  const submit = async () => {
    const t = draft.trim();
    if (!t) return;
    setDraft('');
    setHeard(null);
    setAskedAt(Date.now() - 1000);
    await halo.ask(t);
  };

  return (
    <div style={{ padding: 22 }}>
      <div ref={panel} className="rise" style={{ position: 'relative', borderRadius: 16, overflow: 'hidden', background: 'rgba(10,11,10,.97)', boxShadow: '0 40px 100px rgba(0,0,0,.55), 0 0 0 1px rgba(238,235,227,.16), 0 0 80px rgba(150,190,255,.10)', display: 'flex', flexDirection: 'column' }}>
        <div className="starfield" style={{ position: 'relative', height: 92, backgroundColor: '#0a0b0a', borderBottom: '1px solid var(--line)', flex: '0 0 auto' }} data-tauri-drag-region>
          <div aria-hidden style={{ position: 'absolute', left: 34, top: 46, width: 1, height: 1 }}>
            <span className="corona" style={{ width: 120, height: 120 }} />
            <span className="spike" style={{ width: 120, transform: 'translate(-50%, -50%) rotate(0deg)' }} />
            <span className="spike" style={{ width: 90, transform: 'translate(-50%, -50%) rotate(60deg)' }} />
            <span className="spike" style={{ width: 90, transform: 'translate(-50%, -50%) rotate(120deg)' }} />
            <span className="nucleus" style={{ width: 7, height: 7 }} />
          </div>
          <div style={{ position: 'absolute', left: 72, right: 22, top: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }} data-tauri-drag-region>
            <span className="display" style={{ fontSize: 22, letterSpacing: '0.18em' }}>Halo</span>
            <span className="mono" style={{ fontSize: 9, color: 'var(--muted)' }}>
              {state.busy ? (halo.tool ? `Using ${halo.tool}` : 'Thinking') : `${active.length} working`}
              <span className="sep"> / </span>
              <span style={{ color: waiting.length ? 'var(--signal)' : undefined }}>{waiting.length} waiting on you</span>
            </span>
          </div>
        </div>

        {listening ? (
          <div style={{ padding: '18px 22px', display: 'flex', alignItems: 'center', gap: 18, borderBottom: '1px solid var(--line)' }} aria-live="polite">
            <span className="voice" style={{ fontSize: 24, color: 'var(--star)' }}>{voice.status?.transcribing ? 'Writing it down…' : 'Listening…'}</span>
            <Meter level={voice.level} />
            <span className="mono" style={{ fontSize: 9, color: 'var(--faint)', marginLeft: 'auto' }}>{voice.holding ? `let go of ${hk?.label ?? 'right ⌘'} to ask` : 'tap the mic to stop'}</span>
          </div>
        ) : (
          <form onSubmit={(e) => (e.preventDefault(), submit())} style={{ padding: '6px 22px 0' }}>
            <div className="ask" style={{ borderTop: 0 }}>
              <span className="prompt" aria-hidden>›</span>
              <label className="sr" htmlFor="summon-ask">Ask Halo</label>
              <input ref={input} id="summon-ask" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={heard ? `“${heard}”` : 'Ask anything…'} autoComplete="off" />
              <Mic voice={voice} />
            </div>
          </form>
        )}

        <div style={{ padding: '16px 22px 18px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          {replying && (
            <div style={{ position: 'relative' }}>
              <Crawl entries={entries.filter((e) => e.role !== 'you')} height={170} size={21} />
              {thinking && <span className="mono" style={{ position: 'absolute', left: 0, bottom: 4, fontSize: 10, color: 'var(--faint)' }}>{halo.tool ? `Using ${halo.tool}` : 'Thinking'}<span className="blink">…</span></span>}
            </div>
          )}
          {halo.error && <span style={{ color: 'var(--signal)', fontSize: 13 }}>{halo.error}</span>}
          {!replying && waiting[0] && <Waiting star={waiting[0]} />}

          {chips.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {chips.map((s) => (
                <button key={s.id} className="btn" onClick={() => api.openSky(s.id)} style={{ minHeight: 34, fontSize: 9, gap: 8, textTransform: 'none', letterSpacing: 0, fontFamily: 'var(--ui)' }}>
                  <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: colorOf(s), boxShadow: s.status === 'working' ? '0 0 6px rgba(150,190,255,.9)' : undefined }} />
                  <span style={{ fontSize: 12 }}>{s.title}</span>
                  <span className="mono" style={{ fontSize: 8, color: colorOf(s) }}>{tagOf(s)}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="mono" style={{ display: 'flex', gap: 20, padding: '10px 22px', borderTop: '1px solid var(--line)', fontSize: 8, color: 'var(--faint)', flex: '0 0 auto' }}>
          <span>↩ ask</span>
          <span>esc · dismiss</span>
          <span>⌘↩ · open the sky</span>
          <span>{hk ? `hold ${hk.label} · talk` : ''}</span>
          <button className="btn quiet" onClick={() => api.openSky()} style={{ marginLeft: 'auto', minHeight: 0, fontSize: 8 }}>Open Halo →</button>
        </div>
      </div>
    </div>
  );
}
