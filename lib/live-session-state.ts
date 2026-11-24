import type { WeightUnit } from '@/lib/prisma-client';
import { db } from '@/lib/db';
import { ApiError } from '@/lib/api';
import { getLastPerformances, type LastPerformance } from '@/lib/last-performance';
import { detectPRs, type PRType } from '@/lib/records';
import { isDeloadActive } from '@/lib/deload';
import { getReturnToTrainingRecommendations } from '@/lib/return-to-training-history';
import { liveSessionGymInclude } from '@/lib/session-gym-selection';
import { blockIndexByRow, occurrenceCounts, rowBlockKey, setBlockKey } from '@/lib/exercise-blocks';
import { sessionPlanRows } from '@/lib/session-plan';
import { readinessForSuggestion } from '@/lib/progression';
import {
  gymLoadConstraintsFor,
  initialStrengthTarget,
  intraSetRecommendationFor,
  readinessSignalFromCheckin,
} from '@/lib/live-session-targets';
import { roundWeight, toDisplayWeight, unitLabel } from '@/lib/units';

// Read model of a live session for a coach that cannot see the screen (the
// MCP live-session tools): what is done, which exercise is current, and the
// next set's targets, computed with the same helpers as the session runner
// (lib/live-session-targets.ts). The runner's readiness auto-regulation is a
// per-device preference; the server applies its default (on).

const sessionInclude = {
  workout: {
    include: {
      program: { select: { id: true, name: true } },
      exercises: { orderBy: { order: 'asc' as const }, include: { exercise: true } },
    },
  },
  exercises: { orderBy: { order: 'asc' as const }, include: { exercise: true } },
  sets: { orderBy: [{ completedAt: 'asc' as const }, { setNumber: 'asc' as const }] },
  gym: { include: liveSessionGymInclude },
};

export interface LiveSetView {
  setId: string;
  exerciseId: string;
  exerciseName: string;
  setNumber: number;
  weightKg: number;
  weight: number;
  reps: number;
  rir: number | null;
  durationSec: number | null;
  distanceM: number | null;
  isWarmup: boolean;
  isDropSet: boolean;
  notes: string | null;
  completedAt: string;
}

export interface NextSetTarget {
  programExerciseId: string;
  exerciseId: string;
  exerciseName: string;
  setNumber: number;
  // Strength: load in kg and in the trainee's unit, reps, RIR. targetRIR 0
  // means the set is taken to failure.
  weightKg: number | null;
  weight: number | null;
  reps: number | null;
  rir: number | null;
  toFailure: boolean;
  // Cardio targets from the workout row, when set.
  durationSec: number | null;
  distanceM: number | null;
  restSec: number;
}

export async function getOwnedSessionState(userId: string, sessionId?: string) {
  const session = sessionId
    ? await db.session.findFirst({ where: { id: sessionId, userId }, include: sessionInclude })
    : await db.session.findFirst({
        where: { userId, finishedAt: null },
        orderBy: { startedAt: 'desc' },
        include: sessionInclude,
      });
  if (!session) {
    if (sessionId) throw new ApiError(404, 'Session not found.');
    return null;
  }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { unit: true, deloadUntil: true, bodyweight: true },
  });
  const unit: WeightUnit = user?.unit ?? 'KG';
  // Same rounding as the app shows (one decimal): a gym list stored in kg
  // (18.14 for a 40 lb dumbbell) reads back as 40, not 39.99.
  const display = (kg: number) => roundWeight(toDisplayWeight(kg, unit));

  const rows = sessionPlanRows(session);
  const rowBlocks = blockIndexByRow(rows);
  const counts = occurrenceCounts(rows);
  const blocks = rows.flatMap((pe) => {
    const block = rowBlocks.get(pe.id);
    return block == null
      ? []
      : [{ exerciseId: pe.exerciseId, block, occurrences: counts.get(pe.exerciseId) ?? 0 }];
  });
  const exerciseIds = rows.map((pe) => pe.exerciseId);

  const [lastPerformances, latestCheckin, returnRecommendations] = await Promise.all([
    getLastPerformances(userId, exerciseIds, session.id, blocks),
    db.readinessCheckin.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } }),
    getReturnToTrainingRecommendations({
      userId,
      programExercises: rows,
      excludeSessionId: session.id,
      now: session.startedAt,
      bodyweight: user?.bodyweight ?? null,
      gym: session.gym,
    }),
  ]);
  const now = new Date();
  const readiness = readinessForSuggestion(readinessSignalFromCheckin(latestCheckin), true);
  const deloadActive = isDeloadActive(user?.deloadUntil ?? null, now);

  const names = new Map(rows.map((pe) => [pe.exerciseId, pe.exercise.name]));
  const liveSets = session.sets.map((set) => ({
    ...set,
    createdAt: set.completedAt.getTime(),
  }));
  const keyOfSet = (set: { exerciseId: string; block?: number | null }) => setBlockKey(set, counts);
  const setsByKey = new Map<string, typeof liveSets>();
  for (const set of liveSets) {
    const key = keyOfSet(set);
    if (!setsByKey.has(key)) setsByKey.set(key, []);
    setsByKey.get(key)!.push(set);
  }
  for (const list of setsByKey.values()) list.sort((a, b) => a.setNumber - b.setNumber);
  const rowByKey = new Map(rows.map((pe) => [rowBlockKey(pe, rowBlocks), pe]));

  const view = (set: (typeof liveSets)[number]): LiveSetView => ({
    setId: set.id,
    exerciseId: set.exerciseId,
    exerciseName: names.get(set.exerciseId) ?? 'Exercise',
    setNumber: set.setNumber,
    weightKg: set.weight,
    weight: display(set.weight),
    reps: set.reps,
    rir: set.rir,
    durationSec: set.durationSec,
    distanceM: set.distanceM,
    isWarmup: set.isWarmup,
    isDropSet: set.isDropSet,
    notes: set.notes,
    completedAt: set.completedAt.toISOString(),
  });

  const lastTimeView = (perf: LastPerformance | undefined) =>
    perf
      ? {
          sessionStartedAt: perf.sessionStartedAt.toISOString(),
          sets: perf.sets.map((set) => ({ weight: display(set.weight), reps: set.reps, rir: set.rir })),
        }
      : null;

  const exercises = rows.map((pe) => {
    const key = rowBlockKey(pe, rowBlocks);
    const done = setsByKey.get(key) ?? [];
    const workingDone = done.filter((set) => !set.isWarmup && !set.isDropSet).length;
    return {
      programExerciseId: pe.id,
      exerciseId: pe.exerciseId,
      name: pe.exercise.name,
      muscleGroup: pe.exercise.muscleGroup,
      category: pe.exercise.category,
      equipmentType: pe.exercise.equipmentType,
      supersetGroup: pe.supersetGroup,
      targetSets: pe.targetSets,
      targetRepsMin: pe.targetRepsMin,
      targetRepsMax: pe.targetRepsMax,
      targetRIR: pe.targetRIR,
      toFailure: pe.targetRIR === 0,
      restSec: pe.restSec,
      tempo: pe.tempo,
      // What a coach can say about form: the exercise's own notes (catalog
      // cues) and the program row's notes.
      formCue: pe.exercise.notes,
      rowNotes: pe.notes,
      workingSetsDone: workingDone,
      complete: workingDone >= pe.targetSets,
      // Where the next set of this row is logged: its number and, for an
      // exercise the workout repeats, its block (issue #429).
      nextSetNumber: (done.at(-1)?.setNumber ?? 0) + 1,
      block: rowBlocks.get(pe.id) ?? null,
      sets: done.map(view),
      // The previous session's working sets of this row, so a voice coach can
      // say "last time 40 for 10, 9, 8" and how long ago that was.
      lastTime: lastTimeView(lastPerformances.get(key)),
    };
  });

  const currentIndex = exercises.findIndex((exercise) => !exercise.complete);
  let nextSet: NextSetTarget | null = null;
  if (!session.finishedAt && currentIndex >= 0) {
    const pe = rows[currentIndex]!;
    const key = rowBlockKey(pe, rowBlocks);
    const done = setsByKey.get(key) ?? [];
    const setNumber = (done.at(-1)?.setNumber ?? 0) + 1;
    const isCardio = pe.exercise.category === 'CARDIO';
    let strength: { weight: number; reps: number; rir: number | null } | null = null;
    if (!isCardio) {
      const loadConstraints = gymLoadConstraintsFor(session.gym, pe);
      const recommendation = intraSetRecommendationFor({
        pe,
        rowKey: key,
        keyOfSet,
        completedSets: done,
        sessionSets: liveSets,
        programExerciseForKey: (k) => rowByKey.get(k),
        atMs: now.getTime(),
        readiness,
        deloadActive,
        maxWeight: returnRecommendations[pe.id]?.weightCeiling ?? null,
        loadConstraints,
      });
      strength = initialStrengthTarget({
        pe,
        existingSets: done,
        lastPerf: lastPerformances.get(key),
        readiness,
        deloadActive,
        recommendation,
        returnRecommendation: returnRecommendations[pe.id] ?? null,
        loadConstraints,
      });
    }
    nextSet = {
      programExerciseId: pe.id,
      exerciseId: pe.exerciseId,
      exerciseName: pe.exercise.name,
      setNumber,
      weightKg: strength ? strength.weight : null,
      weight: strength ? display(strength.weight) : null,
      reps: strength ? strength.reps : null,
      rir: strength ? strength.rir : null,
      toFailure: !isCardio && pe.targetRIR === 0,
      durationSec: isCardio ? (pe.targetDurationSec ?? null) : null,
      distanceM: isCardio ? (pe.targetDistanceM ?? null) : null,
      restSec: pe.restSec,
    };
  }

  const lastSet = [...liveSets].sort((a, b) => b.createdAt - a.createdAt)[0];
  // Records the last set beat, against every earlier working set of the
  // exercise (all time, this session included), so a coach can say "that's
  // a new best" or answer "is that a PR".
  let lastSetPRs: PRType[] = [];
  if (lastSet && !lastSet.isWarmup && lastSet.durationSec == null) {
    const earlier = await db.set.findMany({
      where: {
        exerciseId: lastSet.exerciseId,
        isWarmup: false,
        durationSec: null,
        id: { not: lastSet.id },
        completedAt: { lte: lastSet.completedAt },
        session: { userId },
      },
      select: { weight: true, reps: true, isWarmup: true },
    });
    lastSetPRs = detectPRs(lastSet, earlier);
  }
  const restEndsAt =
    lastSet && !session.finishedAt
      ? new Date(
          lastSet.createdAt +
            (rows.find((pe) => rowBlockKey(pe, rowBlocks) === keyOfSet(lastSet))?.restSec ?? 0) *
              1000,
        )
      : null;

  return {
    session: {
      id: session.id,
      startedAt: session.startedAt.toISOString(),
      finishedAt: session.finishedAt?.toISOString() ?? null,
      freestyle: session.freestyle,
      workoutId: session.workoutId,
      workoutName: session.workout?.name ?? null,
      programName: session.workout?.program?.name ?? null,
      gymName: session.gym?.name ?? null,
      notes: session.notes,
    },
    unit: unitLabel(unit),
    deloadActive,
    currentExerciseIndex: currentIndex >= 0 ? currentIndex : null,
    nextSet,
    lastSet: lastSet ? { ...view(lastSet), prs: lastSetPRs } : null,
    rest: restEndsAt
      ? {
          endsAt: restEndsAt.toISOString(),
          remainingSec: Math.max(0, Math.round((restEndsAt.getTime() - now.getTime()) / 1000)),
        }
      : null,
    exercises,
    // Exercises skipped for this session (lib/session-plan.ts): off the plan
    // above, kept so a skip can be taken back.
    skipped: session.exercises
      .filter((row) => row.skippedAt != null)
      .map((row) => ({
        programExerciseId: row.id,
        exerciseId: row.exerciseId,
        name: row.exercise.name,
        skippedAt: row.skippedAt!.toISOString(),
      })),
  };
}

export type LiveSessionState = NonNullable<Awaited<ReturnType<typeof getOwnedSessionState>>>;
