import { db } from '@/lib/db';
import { dateKeyInTimeZone } from '@/lib/history-calendar';

// The active program's workouts for a client that starts sessions (the voice
// coach's phone app): each day with its estimated length and when it was last
// done, the session in progress, and which workout to offer today.

// Rough time a set takes besides its rest: lifting plus setting up. The voice
// coach uses the same figure when it fits a workout into less time.
export const WORK_SEC_PER_SET = 45;

export interface EstimateRow {
  targetSets: number;
  restSec: number;
  targetDurationSec: number | null;
  exercise: { category: string };
}

export function estimateMinutes(rows: readonly EstimateRow[]): number {
  const sec = rows.reduce((sum, row) => {
    if (row.exercise.category === 'CARDIO' && row.targetDurationSec != null) {
      return sum + row.targetDurationSec;
    }
    return sum + row.targetSets * (WORK_SEC_PER_SET + row.restSec);
  }, 0);
  return Math.ceil(sec / 60);
}

export interface WorkoutDay {
  id: string;
  name: string;
  // 1 = Monday ... 7 = Sunday; null when the day is not tied to a weekday.
  dayOfWeek: number | null;
  exerciseCount: number;
  estMinutes: number;
  lastDoneAt: string | null;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function isoWeekday(at: Date, timeZone: string): number {
  const short = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone }).format(at);
  return WEEKDAYS.indexOf(short) + 1;
}

// Which workout to offer: the one in progress; else one scheduled for today
// (only when the zone is known) and not done yet today; else the one after
// the most recently done, in program order; else the first. Empty workouts
// are never offered.
export function suggestWorkout(
  days: readonly WorkoutDay[],
  opts: { inProgressWorkoutId: string | null; now: Date; timeZone?: string },
): string | null {
  const ready = days.filter((d) => d.exerciseCount > 0);
  if (ready.length === 0) return null;
  if (opts.inProgressWorkoutId && ready.some((d) => d.id === opts.inProgressWorkoutId)) {
    return opts.inProgressWorkoutId;
  }
  if (opts.timeZone) {
    const today = dateKeyInTimeZone(opts.now, opts.timeZone);
    const weekday = isoWeekday(opts.now, opts.timeZone);
    const scheduled = ready.find(
      (d) =>
        d.dayOfWeek === weekday &&
        (d.lastDoneAt == null || dateKeyInTimeZone(d.lastDoneAt, opts.timeZone) !== today),
    );
    if (scheduled) return scheduled.id;
  }
  const done = ready.filter((d) => d.lastDoneAt != null);
  if (done.length === 0) return ready[0]!.id;
  const latest = done.reduce((a, b) => (Date.parse(b.lastDoneAt!) > Date.parse(a.lastDoneAt!) ? b : a));
  return ready[(ready.indexOf(latest) + 1) % ready.length]!.id;
}

export async function listWorkouts(userId: string, opts: { now?: Date; timeZone?: string } = {}) {
  const now = opts.now ?? new Date();
  const [program, inProgress] = await Promise.all([
    db.program.findFirst({
      where: { userId, isActive: true },
      select: {
        id: true,
        name: true,
        workouts: {
          orderBy: { order: 'asc' },
          select: {
            id: true,
            name: true,
            dayOfWeek: true,
            exercises: {
              select: {
                targetSets: true,
                restSec: true,
                targetDurationSec: true,
                exercise: { select: { category: true } },
              },
            },
          },
        },
      },
    }),
    db.session.findFirst({
      where: { userId, finishedAt: null },
      orderBy: { startedAt: 'desc' },
      select: { id: true, startedAt: true, workoutId: true, workout: { select: { name: true } } },
    }),
  ]);

  const workoutIds = program?.workouts.map((w) => w.id) ?? [];
  const lastDone = workoutIds.length
    ? await db.session.groupBy({
        by: ['workoutId'],
        where: { userId, workoutId: { in: workoutIds }, finishedAt: { not: null } },
        _max: { startedAt: true },
      })
    : [];
  const lastDoneAt = new Map(lastDone.map((row) => [row.workoutId, row._max.startedAt?.toISOString() ?? null]));

  const days: WorkoutDay[] = (program?.workouts ?? []).map((w) => ({
    id: w.id,
    name: w.name,
    dayOfWeek: w.dayOfWeek,
    exerciseCount: w.exercises.length,
    estMinutes: estimateMinutes(w.exercises),
    lastDoneAt: lastDoneAt.get(w.id) ?? null,
  }));

  return {
    program: program ? { id: program.id, name: program.name } : null,
    workouts: days,
    inProgress: inProgress
      ? {
          sessionId: inProgress.id,
          workoutId: inProgress.workoutId,
          workoutName: inProgress.workout?.name ?? null,
          startedAt: inProgress.startedAt.toISOString(),
        }
      : null,
    suggestedWorkoutId: suggestWorkout(days, {
      inProgressWorkoutId: inProgress?.workoutId ?? null,
      now,
      timeZone: opts.timeZone,
    }),
  };
}
