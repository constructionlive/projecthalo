// How stars read at a glance: their tag, colour, and which ones are shown.

import type { Star } from './types';

const STATUS_TAG: Record<Star['status'], string> = {
  forming: 'Forming',
  working: 'Working',
  needsYou: 'Waiting on you',
  landed: 'Landed',
  failed: 'Failed',
  stopped: 'Stopped',
};

const STATUS_COLOR: Record<Star['status'], string> = {
  forming: 'var(--star)',
  working: 'var(--star)',
  needsYou: 'var(--signal)',
  landed: 'var(--muted)',
  failed: 'var(--signal)',
  stopped: 'var(--faint)',
};

const HOUR = 3_600_000;
/** A finished star cools into a red giant after this… */
const COOL_AFTER = 6 * HOUR;
/** …and leaves the sky for the Nebula after this. */
const REMNANT_AFTER = 48 * HOUR;

export const finished = (s: Star) => s.status === 'landed' || s.status === 'failed' || s.status === 'stopped';

/** How far along a finished star is: fresh, cooling (a red giant), or a remnant. Open ones aren't ageing. */
export function ageOf(s: Star, now = Date.now()): 'fresh' | 'cooling' | 'remnant' | null {
  if (!finished(s)) return null;
  const age = now - s.updated;
  return age > REMNANT_AFTER ? 'remnant' : age > COOL_AFTER ? 'cooling' : 'fresh';
}

export function tagOf(s: Star): string {
  if (s.status === 'working' && s.stalled) return 'Quiet a while';
  const age = ageOf(s);
  if (age === 'remnant') return FATE[fateOf(s)?.fate ?? 'dwarf'].name;
  if (age === 'cooling') return `${STATUS_TAG[s.status]} · cooling`;
  return STATUS_TAG[s.status];
}

export function colorOf(s: Star): string {
  const age = ageOf(s);
  if (age === 'cooling') return 'var(--giant)';
  if (age === 'remnant') return 'var(--faint)';
  return STATUS_COLOR[s.status];
}

const DAY = 24 * HOUR;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** How an old star ends, the way real ones do. */
export type Fate = 'giant' | 'planetary' | 'dwarf' | 'ember' | 'supernova' | 'brown';

export const FATE: Record<Fate, { name: string; says: string }> = {
  giant: { name: 'Red giant', says: 'Swelling and cooling, still in the sky' },
  planetary: { name: 'Planetary nebula', says: 'Blowing off its shells' },
  dwarf: { name: 'White dwarf', says: 'A small hot core, fading slowly' },
  ember: { name: 'Ember', says: 'Nearly cold, deep in the cloud' },
  supernova: { name: 'Supernova remnant', says: 'It failed; the blast is still spreading' },
  brown: { name: 'Brown dwarf', says: 'Stopped before it ever fully lit' },
};

/** An old star's fate, how far through it it is (0…1), and its age in days. Fresh and open stars have none. */
export function fateOf(s: Star, now = Date.now()): { fate: Fate; k: number; days: number } | null {
  const age = ageOf(s, now);
  if (!age || age === 'fresh') return null;
  const days = (now - s.updated) / DAY;
  if (age === 'cooling') return { fate: 'giant', k: clamp01((days * 24 - 6) / 42), days };
  if (s.status === 'failed') return { fate: 'supernova', k: clamp01((days - 2) / 40), days };
  if (s.status === 'stopped') return { fate: 'brown', k: clamp01((days - 2) / 40), days };
  if (days < 7) return { fate: 'planetary', k: clamp01((days - 2) / 5), days };
  if (days < 30) return { fate: 'dwarf', k: clamp01((days - 7) / 23), days };
  return { fate: 'ember', k: clamp01((days - 30) / 60), days };
}

/** What is in the sky: everything open, plus the most recent finished ones. Remnants have left for the Nebula. */
export function orbitStars(stars: Star[], max = 12): Star[] {
  const open = stars.filter((s) => ['forming', 'working', 'needsYou'].includes(s.status));
  const done = stars.filter((s) => !open.includes(s) && ageOf(s) !== 'remnant').sort((a, b) => b.updated - a.updated);
  return [...open, ...done].slice(0, max).sort((a, b) => a.created - b.created);
}
