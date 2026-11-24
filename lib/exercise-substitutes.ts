import type { EquipmentType, ExerciseCategory, MuscleGroup } from '@/lib/prisma-client';
import { db } from '@/lib/db';

// Exercises that can stand in for one in a session: same primary muscle group,
// not already on today's list, and doable in the session's gym. A gym that
// lists its equipment limits the choice to those equipment types (bodyweight
// always works); an exercise the gym marked unavailable is left out. The best
// stand-ins come first: same category (compound for compound), favourites,
// then the ones done most recently, so a familiar lift wins over a new one.

export const SUBSTITUTES_MAX = 10;

export interface Substitute {
  exerciseId: string;
  name: string;
  category: ExerciseCategory;
  equipmentType: EquipmentType;
  isFavorite: boolean;
  lastDoneAt: string | null;
}

export interface SubstituteCandidate {
  id: string;
  name: string;
  muscleGroup: MuscleGroup;
  category: ExerciseCategory;
  equipmentType: EquipmentType;
  isFavorite: boolean;
}

// Pure ranking, so the rules are tested without a database.
export function rankSubstitutes(
  target: { exerciseId: string; muscleGroup: MuscleGroup; category: ExerciseCategory },
  candidates: SubstituteCandidate[],
  options: {
    onList: Set<string>;
    unavailable: Set<string>;
    gymEquipmentTypes: Set<EquipmentType> | null;
    lastDoneAt: Map<string, Date>;
    limit: number;
  },
): Substitute[] {
  const fits = (c: SubstituteCandidate) =>
    c.id !== target.exerciseId &&
    c.muscleGroup === target.muscleGroup &&
    !options.onList.has(c.id) &&
    !options.unavailable.has(c.id) &&
    (options.gymEquipmentTypes == null ||
      c.equipmentType === 'BODYWEIGHT' ||
      options.gymEquipmentTypes.has(c.equipmentType));
  const done = (c: SubstituteCandidate) => options.lastDoneAt.get(c.id)?.getTime() ?? 0;
  return candidates
    .filter(fits)
    .sort(
      (a, b) =>
        Number(b.category === target.category) - Number(a.category === target.category) ||
        Number(b.isFavorite) - Number(a.isFavorite) ||
        done(b) - done(a) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, options.limit)
    .map((c) => ({
      exerciseId: c.id,
      name: c.name,
      category: c.category,
      equipmentType: c.equipmentType,
      isFavorite: c.isFavorite,
      lastDoneAt: options.lastDoneAt.get(c.id)?.toISOString() ?? null,
    }));
}

export async function findSubstitutes(
  userId: string,
  input: {
    sessionId: string;
    gymId: string | null;
    exerciseId: string;
    onList: string[];
    limit?: number;
  },
): Promise<Substitute[]> {
  const target = await db.exercise.findFirst({
    where: { id: input.exerciseId, userId },
    select: { id: true, muscleGroup: true, category: true },
  });
  if (!target) return [];
  const [candidates, equipment, configs] = await Promise.all([
    db.exercise.findMany({
      where: { userId, muscleGroup: target.muscleGroup },
      select: {
        id: true,
        name: true,
        muscleGroup: true,
        category: true,
        equipmentType: true,
        isFavorite: true,
      },
    }),
    input.gymId
      ? db.gymEquipment.findMany({
          where: { gymId: input.gymId, gym: { userId } },
          select: { equipmentType: true },
        })
      : Promise.resolve([]),
    input.gymId
      ? db.gymExerciseConfig.findMany({
          where: { gymId: input.gymId, gym: { userId }, isAvailable: false },
          select: { exerciseId: true },
        })
      : Promise.resolve([]),
  ]);
  const lastDone = await db.set.groupBy({
    by: ['exerciseId'],
    where: { exerciseId: { in: candidates.map((c) => c.id) }, session: { userId } },
    _max: { completedAt: true },
  });
  return rankSubstitutes(
    { exerciseId: target.id, muscleGroup: target.muscleGroup, category: target.category },
    candidates,
    {
      onList: new Set(input.onList),
      unavailable: new Set(configs.map((c) => c.exerciseId)),
      gymEquipmentTypes:
        equipment.length > 0 ? new Set(equipment.map((e) => e.equipmentType)) : null,
      lastDoneAt: new Map(
        lastDone.flatMap((row) =>
          row._max.completedAt ? [[row.exerciseId, row._max.completedAt]] : [],
        ),
      ),
      limit: Math.min(input.limit ?? 5, SUBSTITUTES_MAX),
    },
  );
}
