// Arenas: each workspace is drawn as a circuit of its own. What an arena is
// called and looks like, and how it is doing, from its cars.

import type { ArenaKey, Star, Workspace } from '../lib/types';
import bay from './plates/arena-bay.jpg';
import glace from './plates/arena-glace.jpg';
import mesa from './plates/arena-mesa.jpg';
import porto from './plates/arena-porto.jpg';
import { shortcut } from '../lib/keys';

export const ARENA: Record<ArenaKey, { name: string; image: string; scene: string }> = {
  bay: { name: 'Bay Night', image: bay, scene: 'the circuit on the bay at night, the gantry and the bridge' },
  mesa: { name: 'Mesa Night', image: mesa, scene: 'a floodlit desert canyon circuit under the milky way' },
  porto: { name: 'Porto Quay', image: porto, scene: 'a street circuit along a stone harbour at blue hour' },
  glace: { name: 'Col de Glace', image: glace, scene: 'a snowy mountain pass circuit at blue hour' },
};

/** The arena a workspace is drawn as (an unknown key falls back to the bay). */
export function arenaOf(w: Pick<Workspace, 'arena'> | null | undefined) {
  return ARENA[w?.arena ?? 'bay'] ?? ARENA.bay;
}

/** Stars that belong to no open workspace: they run in folders of their own. */
export function loose(stars: Star[], workspaces: Workspace[]): Star[] {
  const open = new Set(workspaces.map((w) => w.id));
  // A theme's agents work in the Workshop, not in an arena.
  return stars.filter((s) => !s.workspace?.startsWith('theme:') && (!s.workspace || !open.has(s.workspace)));
}

/** An arena's cars: a workspace's, or (null) the loose ones. */
export function carsOf(stars: Star[], workspaces: Workspace[], id: string | null): Star[] {
  return id === null ? loose(stars, workspaces) : stars.filter((s) => s.workspace === id);
}

/** Car numbers by launch order within one arena. */
export function numbers(stars: Star[]): Map<string, string> {
  const m = new Map<string, string>();
  [...stars].sort((a, b) => a.created - b.created).forEach((s, i) => m.set(s.id, String(i + 1).padStart(2, '0')));
  return m;
}

export type ArenaFlag = 'needs' | 'red' | 'racing' | 'quiet';

export interface ArenaStatus {
  flag: ArenaFlag;
  /** One line for the season card. */
  line: string;
  racing: number;
  needs: number;
}

/** A failure stays a red flag this long, unless something newer lands after it. */
const RED_FOR = 6 * 3600_000;

/** How an arena is doing, worst news first. */
export function statusOf(cars: Star[], now = Date.now()): ArenaStatus {
  const num = numbers(cars);
  const tag = (s: Star) => `#${num.get(s.id)} ${s.title}`;
  const racing = cars.filter((s) => s.status === 'working' || s.status === 'forming');
  const needs = cars.filter((s) => s.status === 'needsYou');
  const latestLanding = Math.max(0, ...cars.filter((s) => s.status === 'landed').map((s) => s.updated));
  const red = cars.filter((s) => s.status === 'failed' && now - s.updated < RED_FOR && s.updated > latestLanding).sort((a, b) => b.updated - a.updated)[0];
  const base = { racing: racing.length, needs: needs.length };
  if (needs.length) {
    const s = [...needs].sort((a, b) => b.updated - a.updated)[0];
    return { ...base, flag: 'needs', line: `${tag(s)}: ${s.question ?? s.now}` };
  }
  if (red) return { ...base, flag: 'red', line: `${tag(red)} retired: ${red.error ?? red.now}` };
  if (racing.length) {
    const s = [...racing].sort((a, b) => b.lastActivity - a.lastActivity)[0];
    return { ...base, flag: 'racing', line: `Lap ${Math.max(1, s.turns)} · ${s.title}: ${s.now}` };
  }
  const last = [...cars].sort((a, b) => b.updated - a.updated)[0];
  return { ...base, flag: 'quiet', line: last ? `Quiet. Last in: ${last.title}` : `No cars yet. Launch one with ${shortcut('⌘L')}.` };
}

export const FLAG_WORD: Record<ArenaFlag, string> = { needs: 'Needs you', red: 'Red flag', racing: 'Racing', quiet: 'Quiet' };
