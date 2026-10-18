// A launch's cutscene: the thrusters fire and the car charges the ramp (a
// generated clip). When it ends the live launch takes over. Click or Esc skips.

import { useEffect, useRef } from 'react';

import rearPoster from './plates/rear-poster.jpg';
import rearUrl from './plates/rear.mp4';
import { CUT_T } from './scene';

/** Keeps the clip loaded so a launch starts on its first frame, never black. */
export function CutscenePreload() {
  return <video src={rearUrl} preload="auto" muted playsInline style={{ display: 'none' }} aria-hidden />;
}

export function Cutscene({ title, num, onDone }: { title: string; num: string; onDone: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const done = useRef(false);
  const finish = () => {
    if (done.current) return;
    done.current = true;
    onDone();
  };

  useEffect(() => {
    const keys = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), finish());
    window.addEventListener('keydown', keys, true);
    video.current?.play().catch(() => {});
    return () => window.removeEventListener('keydown', keys, true);
  });

  return (
    <button className="cutscene" onClick={finish} aria-label="Skip the launch cutscene" style={{ backgroundImage: `url(${rearPoster})` }}>
      <video
        ref={video}
        src={rearUrl}
        poster={rearPoster}
        muted
        playsInline
        autoPlay
        preload="auto"
        onTimeUpdate={(e) => e.currentTarget.currentTime >= CUT_T && finish()}
        onEnded={finish}
        onError={finish}
      />
      <span className="cut-third">
        <span className="mono num">{num}</span>
        <span className="name">{title}</span>
        <span className="mono what">Launch</span>
      </span>
      <span className="mono cut-skip">Click or esc to skip</span>
    </button>
  );
}
