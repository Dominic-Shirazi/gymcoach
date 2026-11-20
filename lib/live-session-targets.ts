import type { Exercise, ProgramExercise } from '@/lib/prisma-client';
import {
  READINESS_HOLD_AT_OR_BELOW,
  READINESS_RECENCY_HOURS,
  SORENESS_HOLD_AT_OR_ABOVE,
  suggestNextWeight,
  type ReadinessSignal,
} from '@/lib/progression';
import { recommendNextIntraSet, type IntraSetRecommendation } from '@/lib/intra-set-autoregulation';
import { constrainGymWeightAtOrBelow, type GymLoadConstraints } from '@/lib/gym-loads';
import type { ReturnRecommendation } from '@/lib/return-to-training';

// Next-set targets for a live session, shared by the session runner (client)
// and the MCP live-session state (server) so a voice coach announces exactly
// what the logger would prefill. Pure: callers resolve clocks, readiness and
// the gym before calling.

type ProgramExerciseWithExercise = ProgramExercise & { exercise: Exercise };

// Turn the latest check-in into the readiness signal that drives the load
// suggestion. Only an in-window check-in is forwarded; a stale one is dropped
// so the suggestion stays identical to the no-data path. Returns null when
// there is no usable signal.
export function readinessSignalFromCheckin(
  checkin: {
    readiness: number;
    soreness: unknown;
    createdAt: Date;
  } | null,
  nowMs: number = Date.now(),
): ReadinessSignal | null {
  if (!checkin) return null;
  const ageHours = (nowMs - checkin.createdAt.getTime()) / (1000 * 60 * 60);
  if (ageHours > READINESS_RECENCY_HOURS) return null;

  // soreness is stored as JSON; coerce defensively to a plain { group: 1-5 } map.
  let soreness: ReadinessSignal['soreness'] = null;
  if (
    checkin.soreness &&
    typeof checkin.soreness === 'object' &&
    !Array.isArray(checkin.soreness)
  ) {
    const entries = Object.entries(checkin.soreness as Record<string, unknown>).filter(
      ([, v]) => typeof v === 'number',
    ) as Array<[string, number]>;
    if (entries.length > 0) {
      soreness = Object.fromEntries(entries) as ReadinessSignal['soreness'];
    }
  }

  return { readiness: checkin.readiness, soreness, ageHours };
}

export interface LiveSessionGym {
  dumbbellWeights: number[];
  plateWeights: number[];
  barWeights: number[];
  exerciseConfigs: { exerciseId: string; isAvailable: boolean; weightOptions: number[] }[];
}

// The session gym's load constraints for one exercise. `liveWeightOptions`
// carries options edited during the session (the runner's in-session editor).
export function gymLoadConstraintsFor(
  gym: LiveSessionGym | null,
  pe: { exerciseId: string; exercise: Pick<Exercise, 'equipmentType'> },
  liveWeightOptions?: Record<string, number[]> | null,
): GymLoadConstraints | null {
  if (!gym) return null;
  const config = gym.exerciseConfigs.find((item) => item.exerciseId === pe.exerciseId);
  return {
    equipmentType: pe.exercise.equipmentType,
    isAvailable: config?.isAvailable ?? true,
    dumbbellWeights: gym.dumbbellWeights,
    plateWeights: gym.plateWeights,
    barWeights: gym.barWeights,
    weightOptions: liveWeightOptions?.[pe.exerciseId] ?? config?.weightOptions ?? [],
  };
}

// A set of the current session, as both the runner's pending sets and the
// stored rows can describe it.
export interface LiveSessionSet {
  exerciseId: string;
  block?: number | null;
  weight: number;
  reps: number;
  rir: number | null;
  isWarmup: boolean;
  isDropSet: boolean;
  createdAt: number; // epoch ms
}

export interface IntraSetRecommendationInput<S extends LiveSessionSet> {
  pe: ProgramExerciseWithExercise;
  // Block key of `pe` and of any session set (lib/exercise-blocks).
  rowKey: string;
  keyOfSet: (set: S) => string;
  // Sets of `pe`'s block, in set order.
  completedSets: S[];
  // Every set of the session.
  sessionSets: S[];
  programExerciseForKey: (key: string) => ProgramExerciseWithExercise | undefined;
  atMs: number;
  // Already gated by the auto-regulation preference (readinessForSuggestion).
  readiness: ReadinessSignal | null;
  deloadActive: boolean;
  maxWeight: number | null;
  loadConstraints: GymLoadConstraints | null;
}

// RIR-aware recommendation for the next working set of an exercise that
// already has one in this session; null before the first working set.
export function intraSetRecommendationFor<S extends LiveSessionSet>({
  pe,
  rowKey,
  keyOfSet,
  completedSets,
  sessionSets,
  programExerciseForKey,
  atMs,
  readiness,
  deloadActive,
  maxWeight,
  loadConstraints,
}: IntraSetRecommendationInput<S>): IntraSetRecommendation | null {
  const lastWorkingSet = completedSets.filter((set) => !set.isWarmup && !set.isDropSet).at(-1);
  if (!lastWorkingSet) return null;

  const interveningSet = sessionSets
    .filter(
      (set) =>
        !set.isWarmup &&
        !set.isDropSet &&
        keyOfSet(set) !== rowKey &&
        set.createdAt > lastWorkingSet.createdAt,
    )
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  const interveningPe = interveningSet
    ? programExerciseForKey(keyOfSet(interveningSet))
    : undefined;
  const sameMuscleSuperset = Boolean(
    interveningPe &&
    pe.supersetGroup != null &&
    interveningPe.supersetGroup === pe.supersetGroup &&
    interveningPe.exercise.muscleGroup === pe.exercise.muscleGroup,
  );

  const freshReadiness = readiness != null && readiness.ageHours <= READINESS_RECENCY_HOURS;
  const groupSoreness = readiness?.soreness?.[pe.exercise.muscleGroup];
  const recoveryBlocksIncrease =
    freshReadiness &&
    (readiness.readiness <= READINESS_HOLD_AT_OR_BELOW ||
      (typeof groupSoreness === 'number' && groupSoreness >= SORENESS_HOLD_AT_OR_ABOVE));
  const allowLoadIncrease = !deloadActive && !recoveryBlocksIncrease;

  return recommendNextIntraSet({
    programExercise: pe,
    completedSets,
    recoverySec: Math.max(0, (atMs - lastWorkingSet.createdAt) / 1000),
    sameMuscleSuperset,
    allowLoadIncrease,
    maxWeight,
    loadConstraints,
  });
}

export interface StrengthTarget {
  weight: number;
  reps: number;
  rir: number | null;
}

export interface StrengthTargetInput {
  pe: ProgramExerciseWithExercise;
  existingSets: { weight: number; reps: number; rir: number | null; isWarmup: boolean }[];
  lastPerf:
    | {
        sets: { weight: number; reps: number; rir: number | null }[];
        maxWeight: number;
        repsAtMaxWeight: number;
      }
    | undefined;
  readiness: ReadinessSignal | null;
  deloadActive: boolean;
  recommendation?: IntraSetRecommendation | null;
  returnRecommendation?: ReturnRecommendation | null;
  loadConstraints?: GymLoadConstraints | null;
}

// Load, reps and RIR the logger starts a strength set from (kg).
export function initialStrengthTarget({
  pe,
  existingSets,
  lastPerf,
  readiness,
  deloadActive,
  recommendation = null,
  returnRecommendation = null,
  loadConstraints = null,
}: StrengthTargetInput): StrengthTarget {
  // 1. If a set already exists for this exercise in the current session,
  //    reuse its values (idea: you aim for the same load, adjust the reps).
  const lastInSession = existingSets.filter((s) => !s.isWarmup).at(-1);
  if (lastInSession) {
    return {
      weight: recommendation?.weight ?? lastInSession.weight,
      reps: recommendation?.reps ?? lastInSession.reps,
      rir: recommendation?.rir ?? lastInSession.rir,
    };
  }
  // 2. A return after a long break is a session-only calibration. Keep the
  //    normal progression path intact for ordinary sessions, but start this one
  //    at the conservative history/inventory value and let later sets hand off
  //    to RIR-aware intra-set autoregulation.
  if (returnRecommendation && returnRecommendation.mode !== 'normal') {
    let weight = returnRecommendation.suggestedWeight;
    if (weight == null && lastPerf) {
      const ordinary = suggestNextWeight(
        pe,
        lastPerf.sets,
        readiness,
        deloadActive,
        loadConstraints,
      );
      weight = ordinary.weight ?? lastPerf.maxWeight;
      if (
        returnRecommendation.weightCeiling != null &&
        weight > returnRecommendation.weightCeiling
      ) {
        weight = constrainGymWeightAtOrBelow(returnRecommendation.weightCeiling, loadConstraints);
      }
    }

    return { weight: weight ?? 0, reps: pe.targetRepsMin, rir: pe.targetRIR };
  }

  // 2. Otherwise, pre-fill with the suggestion (double progression algo). If
  //    progressing, aim for the bottom of the rep range with the heavier
  //    load; otherwise try to beat the previous reps (at least match them).
  if (lastPerf) {
    const suggestion = suggestNextWeight(
      pe,
      lastPerf.sets,
      readiness,
      deloadActive,
      loadConstraints,
    );
    const initialReps =
      suggestion.reason === 'progression' ? pe.targetRepsMin : lastPerf.repsAtMaxWeight;
    return {
      weight: suggestion.weight ?? lastPerf.maxWeight,
      reps: initialReps,
      rir: pe.targetRIR,
    };
  }
  // 3. Defaults: middle of the rep range, target RIR, load 0.
  const midReps = Math.round((pe.targetRepsMin + pe.targetRepsMax) / 2);
  return { weight: 0, reps: midReps, rir: pe.targetRIR };
}
