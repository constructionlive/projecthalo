// A newer Halo: one quiet chip in the header until the person wants it, then
// download progress, then Halo restarts into the new version. A critical
// update can't be put off. Shows nothing when Halo is the newest.

import { useEffect, useState } from 'react';

import { api, inApp } from '../lib/api';
import type { UpdateInfo } from '../lib/types';
import { Md } from './Md';

const LATER_KEY = 'halo-update-later';

function laterFor(version: string): boolean {
  try {
    return localStorage.getItem(LATER_KEY) === version;
  } catch {
    return false;
  }
}

export function UpdateChip() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    // What the background check found, and a look now in case it found it before this window opened.
    api.updateCheck().then((u) => u && setInfo(u)).catch(() => {});
    const offs = [api.on<UpdateInfo>('update-available', setInfo), api.on<{ done: number; total: number | null }>('update-progress', setProgress)];
    return () => offs.forEach((o) => o.then((f) => f()));
  }, []);
  useEffect(() => {
    if (info && !info.critical) setHidden(laterFor(info.version));
  }, [info]);

  if (!info || hidden) return null;
  const install = async () => {
    setError(null);
    setProgress({ done: 0, total: null });
    try {
      await api.updateInstall();
      if (!inApp) setProgress(null);
    } catch (e) {
      setError(String(e));
      setProgress(null);
    }
  };
  const later = () => {
    try {
      localStorage.setItem(LATER_KEY, info.version);
    } catch {
      /* it comes back next time */
    }
    setHidden(true);
    setOpen(false);
  };
  const pct = progress?.total ? Math.round((progress.done / progress.total) * 100) : null;
  return (
    <div className={`update-chip${info.critical ? ' critical' : ''}`}>
      <button className="update-chip-main mono" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="update-dot" aria-hidden />
        {info.critical ? 'Important update' : `Halo ${info.version}`}
      </button>
      {open && (
        <div className="update-panel" role="dialog" aria-label={`Halo ${info.version}`}>
          <span className="mono update-head">
            Halo {info.version} <span className="sep">·</span> you have {info.current}
          </span>
          {info.notes && (
            <div className="update-notes">
              <Md text={info.notes} />
            </div>
          )}
          {progress ? (
            <div className="update-progress" aria-live="polite">
              <div className="update-bar">
                <span style={{ width: `${pct ?? 8}%` }} />
              </div>
              <span className="mono">{pct === null ? 'Downloading…' : pct < 100 ? `Downloading ${pct}%` : 'Installing… Halo restarts by itself'}</span>
            </div>
          ) : (
            <div className="update-actions">
              <button className={`btn ${info.critical ? 'signal' : 'solid'}`} onClick={install}>Update & restart</button>
              {!info.critical && <button className="btn quiet" onClick={later}>Later</button>}
            </div>
          )}
          {error && <p className="update-error" role="alert">{error}</p>}
          <span className="update-note">Your agents and terminals stop for the restart; your threads, workspaces and themes stay.</span>
        </div>
      )}
    </div>
  );
}
