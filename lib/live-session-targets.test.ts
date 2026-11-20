import { describe, expect, it } from 'vitest';
import type { Exercise, ProgramExercise } from '@/lib/prisma-client';
import {
  gymLoadConstraintsFor,
  initialStrengthTarget,
  intraSetRecommendationFor,
  readinessSignalFromCheckin,
  type LiveSessionSet,
} from './live-session-targets';

function pe(overrides: Partial<ProgramExercise> = {}): ProgramExercise & { exercise: Exercise } {
  return {
    id: 'pe-1',
    workoutId: 'w-1',
    exerciseId: 'ex-1',
    order: 0,
    targetSets: 3,
    targetRepsMin: 6,
    targetRepsMax: 10,
    targetRIR: 2,
    restSec: 120,
    tempo: null,
    notes: null,
    supersetGroup: null,
    autoregulationMode: 'PRESERVE_RIR',
    fatigueRate: null,
    loadAdjustmentPct: null,
    targetDurationSec: null,
    targetDistanceM: null,
    ...overrides,
    exercise: {
      id: 'ex-1',
      userId: 'u-1',
      name: 'Press',
      muscleGroup: 'SHOULDERS_FRONT',
      category: 'COMPOUND',
      defaultRestSec: 120,
      notes: null,
      usesBodyweight: false,
      equipmentType: 'DUMBBELL',
      isFavorite: false,
      createdAt: new Date(0),
    } as Exercise,
  } as ProgramExercise & { exercise: Exercise };
}

describe('readinessSignalFromCheckin', () => {
  const now = Date.UTC(2026, 10, 20, 12);

  it('drops a missing or stale check-in', () => {
    expect(readinessSignalFromCheckin(null, now)).toBeNull();
    const old = new Date(now - 72 * 3600 * 1000);
    expect(
      readinessSignalFromCheckin({ readiness: 3, soreness: null, createdAt: old }, now),
    ).toBeNull();
  });

  it('keeps only numeric soreness entries', () => {
    const signal = readinessSignalFromCheckin(
      { readiness: 2, soreness: { CHEST: 4, BICEPS: 'x' }, createdAt: new Date(now - 3600 * 1000) },
      now,
    );
    expect(signal).toEqual({ readiness: 2, soreness: { CHEST: 4 }, ageHours: 1 });
  });
});

describe('gymLoadConstraintsFor', () => {
  const gym = {
    dumbbellWeights: [10, 20],
    plateWeights: [],
    barWeights: [],
    exerciseConfigs: [{ exerciseId: 'ex-1', isAvailable: false, weightOptions: [5] }],
  };

  it('is null without a gym and reads the exercise config otherwise', () => {
    expect(gymLoadConstraintsFor(null, pe())).toBeNull();
    expect(gymLoadConstraintsFor(gym, pe())).toEqual({
      equipmentType: 'DUMBBELL',
      isAvailable: false,
      dumbbellWeights: [10, 20],
      plateWeights: [],
      barWeights: [],
      weightOptions: [5],
    });
  });

  it('prefers options edited during the session', () => {
    expect(gymLoadConstraintsFor(gym, pe(), { 'ex-1': [7.5] })?.weightOptions).toEqual([7.5]);
  });
});

describe('initialStrengthTarget', () => {
  it('starts from the middle of the range at the target RIR without history', () => {
    expect(
      initialStrengthTarget({
        pe: pe(),
        existingSets: [],
        lastPerf: undefined,
        readiness: null,
        deloadActive: false,
      }),
    ).toEqual({ weight: 0, reps: 8, rir: 2 });
  });

  it('progresses from the last session when every working set hit the top of the range', () => {
    const target = initialStrengthTarget({
      pe: pe(),
      existingSets: [],
      lastPerf: {
        sets: [
          { weight: 20, reps: 10, rir: 2 },
          { weight: 20, reps: 10, rir: 2 },
        ],
        maxWeight: 20,
        repsAtMaxWeight: 10,
      },
      readiness: null,
      deloadActive: false,
    });
    expect(target.weight).toBeGreaterThan(20);
    expect(target.reps).toBe(6);
  });

  it('follows the in-session recommendation once a set is logged', () => {
    const target = initialStrengthTarget({
      pe: pe(),
      existingSets: [{ weight: 20, reps: 8, rir: 2, isWarmup: false }],
      lastPerf: undefined,
      readiness: null,
      deloadActive: false,
      recommendation: {
        mode: 'PRESERVE_RIR',
        weight: 20,
        reps: 7,
        rir: 2,
        reason: 'adjust-reps',
        predictedRepsAtSameLoad: 7,
        fatigueLoss: 1,
        confidence: 'medium',
      },
    });
    expect(target).toEqual({ weight: 20, reps: 7, rir: 2 });
  });
});

describe('intraSetRecommendationFor', () => {
  const set = (overrides: Partial<LiveSessionSet> = {}): LiveSessionSet => ({
    exerciseId: 'ex-1',
    weight: 20,
    reps: 8,
    rir: 2,
    isWarmup: false,
    isDropSet: false,
    createdAt: 1_000,
    ...overrides,
  });
  const base = {
    pe: pe(),
    rowKey: 'ex-1',
    keyOfSet: (s: LiveSessionSet) => s.exerciseId,
    programExerciseForKey: () => undefined,
    atMs: 121_000,
    readiness: null,
    deloadActive: false,
    maxWeight: null,
    loadConstraints: null,
  };

  it('is null before the first working set', () => {
    const warmup = set({ isWarmup: true });
    expect(
      intraSetRecommendationFor({ ...base, completedSets: [warmup], sessionSets: [warmup] }),
    ).toBeNull();
  });

  it('recommends the next set from the last working set', () => {
    const done = set();
    const rec = intraSetRecommendationFor({ ...base, completedSets: [done], sessionSets: [done] });
    expect(rec).not.toBeNull();
    expect(rec!.rir).toBe(2);
    expect(rec!.reps).toBeGreaterThanOrEqual(6);
    expect(rec!.reps).toBeLessThanOrEqual(10);
  });

  it('never raises the load during a deload', () => {
    const easy = set({ reps: 10, rir: 5 });
    const rec = intraSetRecommendationFor({
      ...base,
      deloadActive: true,
      completedSets: [easy],
      sessionSets: [easy],
    });
    expect(rec!.weight).toBeLessThanOrEqual(20);
  });
});
