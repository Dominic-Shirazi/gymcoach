import { describe, expect, it } from 'vitest';
import { estimateMinutes, suggestWorkout, type WorkoutDay } from './workout-list';

const day = (id: string, over: Partial<WorkoutDay> = {}): WorkoutDay => ({
  id,
  name: id,
  dayOfWeek: null,
  exerciseCount: 3,
  estMinutes: 20,
  lastDoneAt: null,
  ...over,
});

// 2026-11-25 is a Wednesday (3); 06:00 UTC is still Tuesday evening in Los Angeles.
const now = new Date('2026-11-25T18:00:00Z');

describe('estimateMinutes', () => {
  it('counts each set as 45 s of work plus its rest, and cardio by its duration', () => {
    expect(
      estimateMinutes([
        { targetSets: 3, restSec: 90, targetDurationSec: null, exercise: { category: 'COMPOUND' } },
        { targetSets: 2, restSec: 60, targetDurationSec: null, exercise: { category: 'ISOLATION' } },
        { targetSets: 1, restSec: 0, targetDurationSec: 600, exercise: { category: 'CARDIO' } },
      ]),
    ).toBe(Math.ceil((3 * 135 + 2 * 105 + 600) / 60));
  });

  it('is 0 for an empty workout', () => {
    expect(estimateMinutes([])).toBe(0);
  });
});

describe('suggestWorkout', () => {
  it('offers the workout in progress first', () => {
    const days = [day('a'), day('b', { dayOfWeek: 3 })];
    expect(suggestWorkout(days, { inProgressWorkoutId: 'a', now, timeZone: 'UTC' })).toBe('a');
  });

  it("offers today's scheduled day unless it was already done today", () => {
    const days = [day('a', { lastDoneAt: '2026-11-20T18:00:00Z' }), day('b', { dayOfWeek: 3 })];
    expect(suggestWorkout(days, { inProgressWorkoutId: null, now, timeZone: 'UTC' })).toBe('b');
    const doneToday = [day('a', { lastDoneAt: '2026-11-20T18:00:00Z' }), day('b', { dayOfWeek: 3, lastDoneAt: '2026-11-25T08:00:00Z' })];
    expect(suggestWorkout(doneToday, { inProgressWorkoutId: null, now, timeZone: 'UTC' })).toBe('a');
  });

  it("reads the weekday in the trainee's zone, and ignores weekdays without one", () => {
    const early = new Date('2026-11-25T06:00:00Z');
    const days = [day('a'), day('tue', { dayOfWeek: 2 }), day('wed', { dayOfWeek: 3 })];
    expect(suggestWorkout(days, { inProgressWorkoutId: null, now: early, timeZone: 'America/Los_Angeles' })).toBe('tue');
    expect(suggestWorkout(days, { inProgressWorkoutId: null, now: early, timeZone: 'UTC' })).toBe('wed');
    expect(suggestWorkout(days, { inProgressWorkoutId: null, now: early })).toBe('a');
  });

  it('otherwise offers the day after the most recently done one, wrapping around', () => {
    const days = [
      day('a', { lastDoneAt: '2026-11-20T18:00:00Z' }),
      day('b', { lastDoneAt: '2026-11-22T18:00:00Z' }),
      day('c', { lastDoneAt: '2026-11-18T18:00:00Z' }),
    ];
    expect(suggestWorkout(days, { inProgressWorkoutId: null, now })).toBe('c');
    days[2]!.lastDoneAt = '2026-11-24T18:00:00Z';
    expect(suggestWorkout(days, { inProgressWorkoutId: null, now })).toBe('a');
  });

  it('never offers an empty workout, and offers the first when nothing was done', () => {
    expect(suggestWorkout([day('empty', { exerciseCount: 0 }), day('a'), day('b')], { inProgressWorkoutId: null, now })).toBe('a');
    expect(suggestWorkout([day('empty', { exerciseCount: 0 })], { inProgressWorkoutId: null, now })).toBeNull();
  });
});
