// A new theme, plain on purpose: Halo's words, the agents at work, the ask
// line. Everything here is yours to change; see KIT.md for what Halo gives a
// theme and how to build it.

import './theme.css';

import { ThreadView } from '@halo/ui/components/ThreadView';
import type { ThemeProps } from '@halo/ui/kit/theme';

export default function Theme({ halo, draft, setDraft, now }: ThemeProps) {
  const { state, stars } = halo;
  const working = stars.filter((s) => s.status === 'working' || s.status === 'forming');
  const needs = stars.filter((s) => s.status === 'needsYou');
  return (
    <main className="t-root">
      <header className="t-top">
        <span className="t-name">Halo</span>
        <span className="t-now">{now}</span>
      </header>
      <section className="t-thread" aria-label="The thread">
        <ThreadView lines={state.lines} chunks={halo.chunks} names={{ halo: 'Halo', back: 'top' }} onStar={() => {}} onBack={() => {}} />
      </section>
      <aside className="t-agents" aria-label="Agents">
        {needs.map((s) => (
          <div key={s.id} className="t-agent needs">
            <strong>{s.title}</strong>
            <span>{s.question ?? s.now}</span>
          </div>
        ))}
        {working.map((s) => (
          <div key={s.id} className="t-agent">
            <strong>{s.title}</strong>
            <span>{s.now}</span>
          </div>
        ))}
        {needs.length + working.length === 0 && <p className="t-quiet">No agents at work.</p>}
      </aside>
      <form
        className="t-ask"
        onSubmit={(e) => {
          e.preventDefault();
          const t = draft.trim();
          if (!t) return;
          setDraft('');
          halo.ask(t);
        }}
      >
        <label className="sr" htmlFor="t-ask">Ask Halo</label>
        <input id="t-ask" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Ask Halo…" autoComplete="off" />
      </form>
    </main>
  );
}
