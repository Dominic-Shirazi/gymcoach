import type { WeightUnit } from '@/lib/prisma-client';
import { db } from '@/lib/db';
import { ApiError } from '@/lib/api';
import { exerciseProgress, isStalled, STALL_LOOKBACK_SESSIONS } from '@/lib/stats';
import { roundWeight, toDisplayWeight, unitLabel } from '@/lib/units';

// One exercise's recent sessions, all-time bests and trend, in the trainee's
// unit: what a coach needs to answer "what did I bench last week", "is that
// a PR" or "am I getting stronger on squat" in one sentence. Read-only and
// derived from the stored sets, like the progress page.

export const HISTORY_DEFAULT_SESSIONS = 6;
export const HISTORY_MAX_SESSIONS = 20;
// A trend needs this many sessions; fewer reads as not enough data.
export const TREND_MIN_SESSIONS = 3;
// Change in best estimated 1RM, first to last session of the window, that
// counts as up or down rather than flat.
export const TREND_FLAT_PCT = 2;

type Trend = 'up' | 'flat' | 'down' | 'not_enough_data';

interface Candidate {
  id: string;
  name: string;
  category: string;
}

// Exact name first, then names starting with the query, then names holding
// every word of it. Several matches at the best level are returned as
// candidates so the caller can ask which one was meant.
export function matchExercises<T extends Candidate>(query: string, exercises: T[]): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/);
  const exact = exercises.filter((e) => e.name.toLowerCase() === q);
  if (exact.length) return exact;
  const prefix = exercises.filter((e) => e.name.toLowerCase().startsWith(q));
  if (prefix.length) return prefix;
  return exercises.filter((e) => {
    const name = e.name.toLowerCase();
    return words.every((w) => name.includes(w));
  });
}

// Several exercises match a name ("bench"): the one in the active program
// wins, then one with logged sets. A unique winner is used; otherwise the
// candidates come back in that order for the caller to ask about.
export function pickMatch<T extends Candidate>(
  matches: T[],
  inActiveProgram: ReadonlySet<string>,
  logged: ReadonlySet<string>,
): { order: T[]; unique: boolean } {
  const score = (m: T) => (inActiveProgram.has(m.id) ? 2 : 0) + (logged.has(m.id) ? 1 : 0);
  const order = [...matches].sort((a, b) => score(b) - score(a));
  const top = score(order[0]!);
  const unique = top > 0 && (order.length === 1 || score(order[1]!) < top);
  return { order, unique };
}

async function rankMatches<T extends Candidate>(userId: string, matches: T[]) {
  const ids = matches.map((m) => m.id);
  const [programRows, loggedRows] = await Promise.all([
    db.programExercise.findMany({
      where: { exerciseId: { in: ids }, workout: { program: { userId, isActive: true } } },
      select: { exerciseId: true },
    }),
    db.set.findMany({
      where: { exerciseId: { in: ids }, session: { userId } },
      select: { exerciseId: true },
      distinct: ['exerciseId'],
    }),
  ]);
  return pickMatch(
    matches,
    new Set(programRows.map((r) => r.exerciseId)),
    new Set(loggedRows.map((r) => r.exerciseId)),
  );
}

export function trendOf(e1rms: number[]): { trend: Trend; changePct: number | null } {
  if (e1rms.length < TREND_MIN_SESSIONS) return { trend: 'not_enough_data', changePct: null };
  const first = e1rms[0]!;
  const last = e1rms[e1rms.length - 1]!;
  if (first <= 0) return { trend: 'not_enough_data', changePct: null };
  const changePct = Math.round(((last - first) / first) * 1000) / 10;
  const trend: Trend = changePct > TREND_FLAT_PCT ? 'up' : changePct < -TREND_FLAT_PCT ? 'down' : 'flat';
  return { trend, changePct };
}

export async function getExerciseHistory(
  userId: string,
  input: { exerciseId?: string; query?: string; sessions?: number },
) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { unit: true } });
  const unit: WeightUnit = user?.unit ?? 'KG';
  const display = (kg: number) => roundWeight(toDisplayWeight(kg, unit));

  let exercise: Candidate | null = null;
  if (input.exerciseId) {
    exercise = await db.exercise.findFirst({
      where: { id: input.exerciseId, userId },
      select: { id: true, name: true, category: true },
    });
    if (!exercise) throw new ApiError(404, 'Exercise not found.');
  } else if (input.query) {
    const all = await db.exercise.findMany({ where: { userId }, select: { id: true, name: true, category: true } });
    const matches = matchExercises(input.query, all);
    if (matches.length === 0) return { found: false as const, query: input.query, candidates: [] };
    if (matches.length > 1) {
      const ranked = await rankMatches(userId, matches);
      if (!ranked.unique) {
        return { found: false as const, query: input.query, candidates: ranked.order.slice(0, 8).map((m) => m.name) };
      }
      exercise = ranked.order[0]!;
    } else {
      exercise = matches[0]!;
    }
  } else {
    throw new ApiError(400, 'Give an exerciseId or a query.');
  }

  const limit = Math.min(Math.max(input.sessions ?? HISTORY_DEFAULT_SESSIONS, 1), HISTORY_MAX_SESSIONS);
  const rows = await db.set.findMany({
    where: { exerciseId: exercise.id, isWarmup: false, durationSec: null, session: { userId } },
    orderBy: [{ completedAt: 'asc' }, { setNumber: 'asc' }],
    select: {
      weight: true,
      reps: true,
      rir: true,
      isWarmup: true,
      durationSec: true,
      completedAt: true,
      sessionId: true,
      session: { select: { startedAt: true } },
    },
  });

  const points = exerciseProgress(
    rows.map((r) => ({ ...r, sessionStartedAt: r.session.startedAt })),
  );
  const recent = points.slice(-limit);
  const setsBySession = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!setsBySession.has(r.sessionId)) setsBySession.set(r.sessionId, []);
    setsBySession.get(r.sessionId)!.push(r);
  }
  const sessionIdsInOrder = [...setsBySession.keys()].sort(
    (a, b) => setsBySession.get(a)![0]!.session.startedAt.getTime() - setsBySession.get(b)![0]!.session.startedAt.getTime(),
  );

  let heaviest: (typeof rows)[number] | null = null;
  for (const r of rows) {
    if (!heaviest || r.weight > heaviest.weight || (r.weight === heaviest.weight && r.reps > heaviest.reps)) heaviest = r;
  }
  let bestE1rm: (typeof points)[number] | null = null;
  for (const p of points) if (!bestE1rm || p.estimated1RM > bestE1rm.estimated1RM) bestE1rm = p;

  const series = recent.map((p) => p.estimated1RM);
  return {
    found: true as const,
    exercise: { id: exercise.id, name: exercise.name },
    unit: unitLabel(unit),
    sessions: sessionIdsInOrder.slice(-limit).map((id) => {
      const sets = setsBySession.get(id)!;
      return {
        sessionStartedAt: sets[0]!.session.startedAt.toISOString(),
        sets: sets.map((s) => ({ weight: display(s.weight), reps: s.reps, rir: s.rir })),
      };
    }),
    records: {
      heaviest: heaviest
        ? { weight: display(heaviest.weight), reps: heaviest.reps, date: heaviest.session.startedAt.toISOString() }
        : null,
      bestEstimated1RM: bestE1rm
        ? { value: display(bestE1rm.estimated1RM), date: bestE1rm.sessionStartedAt.toISOString() }
        : null,
    },
    trend: {
      ...trendOf(series),
      sessions: series.length,
      stalled: series.length >= STALL_LOOKBACK_SESSIONS ? isStalled(series) : false,
      estimated1RMs: series.map(display),
    },
  };
}
