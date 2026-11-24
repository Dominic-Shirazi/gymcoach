import { describe, expect, it } from 'vitest';
import { matchExercises, pickMatch, trendOf } from '@/lib/exercise-history';

const ex = (name: string) => ({ id: name, name, category: 'COMPOUND' });
const catalog = [
  ex('Flat dumbbell bench press'),
  ex('Incline dumbbell press (30 deg)'),
  ex('Goblet squat'),
  ex('Bulgarian split squat'),
];

describe('matchExercises', () => {
  it('prefers an exact name, then a prefix, then all words', () => {
    expect(matchExercises('goblet squat', catalog).map((e) => e.name)).toEqual(['Goblet squat']);
    expect(matchExercises('flat', catalog).map((e) => e.name)).toEqual(['Flat dumbbell bench press']);
    expect(matchExercises('bench', catalog).map((e) => e.name)).toEqual(['Flat dumbbell bench press']);
  });

  it('returns every match when the query is ambiguous', () => {
    expect(matchExercises('squat', catalog).map((e) => e.name)).toEqual(['Goblet squat', 'Bulgarian split squat']);
    expect(matchExercises('deadlift', catalog)).toEqual([]);
  });
});

describe('trendOf', () => {
  it('needs three sessions', () => {
    expect(trendOf([50, 52])).toEqual({ trend: 'not_enough_data', changePct: null });
  });

  it('reads up, flat and down from first to last', () => {
    expect(trendOf([50, 51, 53])).toEqual({ trend: 'up', changePct: 6 });
    expect(trendOf([50, 49, 50.5])).toEqual({ trend: 'flat', changePct: 1 });
    expect(trendOf([50, 48, 47])).toEqual({ trend: 'down', changePct: -6 });
  });
});

describe('pickMatch', () => {
  const [bench, incline, goblet, split] = catalog;
  it('prefers the active program, then logged history', () => {
    expect(pickMatch([incline!, bench!], new Set([bench!.id]), new Set())).toEqual({ order: [bench, incline], unique: true });
    expect(pickMatch([goblet!, split!], new Set(), new Set([split!.id]))).toEqual({ order: [split, goblet], unique: true });
    expect(pickMatch([goblet!, split!], new Set([goblet!.id]), new Set([split!.id]))).toMatchObject({ unique: true, order: [goblet, split] });
  });

  it('stays ambiguous on a tie or with nothing to go on', () => {
    expect(pickMatch([goblet!, split!], new Set(), new Set()).unique).toBe(false);
    expect(pickMatch([goblet!, split!], new Set([goblet!.id, split!.id]), new Set()).unique).toBe(false);
  });
});
