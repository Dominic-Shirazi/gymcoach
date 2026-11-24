import { describe, expect, it } from 'vitest';
import { rankSubstitutes, type SubstituteCandidate } from './exercise-substitutes';

const c = (id: string, over: Partial<SubstituteCandidate> = {}): SubstituteCandidate => ({
  id,
  name: id,
  muscleGroup: 'CHEST',
  category: 'COMPOUND',
  equipmentType: 'DUMBBELL',
  isFavorite: false,
  ...over,
});

const target = {
  exerciseId: 'bench',
  muscleGroup: 'CHEST' as const,
  category: 'COMPOUND' as const,
};
const base = {
  onList: new Set<string>(),
  unavailable: new Set<string>(),
  gymEquipmentTypes: null,
  lastDoneAt: new Map<string, Date>(),
  limit: 5,
};

describe('rankSubstitutes', () => {
  it('keeps the same muscle group, never the exercise itself or one already on the list', () => {
    const out = rankSubstitutes(
      target,
      [c('bench'), c('incline'), c('row', { muscleGroup: 'BACK_THICKNESS' }), c('floor')],
      { ...base, onList: new Set(['floor']) },
    );
    expect(out.map((s) => s.exerciseId)).toEqual(['incline']);
  });

  it("keeps to the gym's equipment types, bodyweight always allowed", () => {
    const out = rankSubstitutes(
      target,
      [
        c('db', { equipmentType: 'DUMBBELL' }),
        c('cable', { equipmentType: 'CABLE' }),
        c('machine', { equipmentType: 'MACHINE' }),
        c('pushup', { equipmentType: 'BODYWEIGHT' }),
      ],
      { ...base, gymEquipmentTypes: new Set(['DUMBBELL'] as const) },
    );
    expect(out.map((s) => s.exerciseId).sort()).toEqual(['db', 'pushup']);
  });

  it('leaves out an exercise the gym marked unavailable', () => {
    const out = rankSubstitutes(target, [c('a'), c('b')], { ...base, unavailable: new Set(['a']) });
    expect(out.map((s) => s.exerciseId)).toEqual(['b']);
  });

  it('ranks same category, then favourites, then most recently done, then name', () => {
    const out = rankSubstitutes(
      target,
      [
        c('fly', { category: 'ISOLATION', isFavorite: true }),
        c('z-old'),
        c('y-new'),
        c('fav', { isFavorite: true }),
        c('a-never'),
      ],
      {
        ...base,
        lastDoneAt: new Map([
          ['z-old', new Date('2026-01-01')],
          ['y-new', new Date('2026-11-01')],
        ]),
      },
    );
    expect(out.map((s) => s.exerciseId)).toEqual(['fav', 'y-new', 'z-old', 'a-never', 'fly']);
    expect(out[1]!.lastDoneAt).toBe('2026-11-01T00:00:00.000Z');
  });

  it('stops at the limit', () => {
    const out = rankSubstitutes(target, [c('a'), c('b'), c('c')], { ...base, limit: 2 });
    expect(out).toHaveLength(2);
  });
});
