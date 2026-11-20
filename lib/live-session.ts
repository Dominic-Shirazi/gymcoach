import type { Exercise, Prisma, Session, Set } from '@/lib/prisma-client';
import { db } from '@/lib/db';
import { ApiError } from '@/lib/api';
import { findAchievingSet, setAchievesGoal } from '@/lib/goals';
import { effectiveWeight } from '@/lib/stats';
import { resolveSetEquipmentSnapshot } from '@/lib/set-equipment';
import { effectiveSetBlock } from '@/lib/exercise-blocks';
import { resolveFinishedAt } from '@/lib/session-finish';
import { validateSetForCategory, type SetInput, type SetUpdateInput } from '@/lib/schemas/set';
import type { SessionStart, SessionUpdate } from '@/lib/schemas/session';

// Live-session writes shared by the REST routes (app/api/sessions/**,
// app/api/sets/**) and the MCP live-session tools, so both entry points start,
// log, correct and finish a session through the same rules. Inputs are already
// Zod-validated by the caller; every query is scoped by userId (issue #317),
// and a foreign or unknown id reads as not found.

export interface StartedSession {
  session: Session;
  // False when an unfinished session on the same workout (or the open
  // freestyle session) was returned instead of creating a second one.
  created: boolean;
}

// Starts a session on one of the user's workouts, or a freestyle session when
// no workout is given (issue #388). Returns the unfinished session that already
// exists on the same workout instead of creating a second one (avoids zombie
// sessions created by a double-click); a freestyle start resumes the
// unfinished freestyle session.
export async function startOwnedSession(
  userId: string,
  { workoutId, gymId }: SessionStart,
): Promise<StartedSession> {
  const workout = workoutId
    ? await db.workout.findFirst({
        where: { id: workoutId, program: { userId } },
      })
    : null;
  if (workoutId && !workout) {
    throw new ApiError(404, 'Session not found.');
  }

  const selectedGymId =
    gymId ??
    (await db.user.findUnique({ where: { id: userId }, select: { activeGymId: true } }))
      ?.activeGymId ??
    null;
  if (selectedGymId) {
    const gym = await db.gym.findFirst({
      where: { id: selectedGymId, userId },
      select: { id: true },
    });
    if (!gym) throw new ApiError(400, 'Invalid gym.');
  }

  // A freestyle start resumes only a session that was started as one. An
  // open session that lost its workout or its whole program also has no
  // workoutId and no programId, so the explicit marker decides.
  const inProgress = await db.session.findFirst({
    where: workout
      ? { userId, workoutId: workout.id, finishedAt: null }
      : { userId, freestyle: true, finishedAt: null },
    orderBy: { startedAt: 'desc' },
  });
  if (inProgress) {
    // We return the existing session instead of creating a new one:
    // allows resuming cleanly after a reload.
    return { session: inProgress, created: false };
  }

  const created = await db.session.create({
    data: {
      userId,
      workoutId: workout?.id ?? null,
      programId: workout?.programId ?? null,
      freestyle: !workout,
      gymId: selectedGymId,
    },
  });
  return { session: created, created: true };
}

// Updates the notes and, with `finish`, finishes the session. A late Finish
// ends the session at its last set, not at the tap (issue #571,
// lib/session-finish.ts). As before, every `finish: true` stamps the session
// again, including one sent for an already finished session.
export async function updateOwnedSession(
  userId: string,
  sessionId: string,
  data: SessionUpdate,
): Promise<Session> {
  const session = await db.session.findFirst({ where: { id: sessionId, userId } });
  if (!session) throw new ApiError(404, 'Session not found.');

  let finishedAt = session.finishedAt;
  if (data.finish) {
    const lastSet = await db.set.findFirst({
      where: { sessionId: session.id, session: { userId } },
      orderBy: { completedAt: 'desc' },
      select: { completedAt: true },
    });
    finishedAt = resolveFinishedAt({
      now: new Date(),
      startedAt: session.startedAt,
      lastSetAt: lastSet?.completedAt ?? null,
    });
  }

  return db.session.update({
    where: { id: sessionId, userId },
    data: {
      notes: data.notes ?? session.notes,
      finishedAt,
    },
  });
}

// Records a set in an open session of the user.
export async function logOwnedSet(userId: string, sessionId: string, data: SetInput): Promise<Set> {
  // Scoped reads (issue #317): ownership is part of each query, not a
  // separate comparison that a later edit could drop.
  const session = await db.session.findFirst({ where: { id: sessionId, userId } });
  if (!session) {
    throw new ApiError(404, 'Session not found.');
  }
  if (session.finishedAt) {
    throw new ApiError(400, 'Session already finished.');
  }

  // Validation: the exercise must belong to the user.
  const exercise = await db.exercise.findFirst({
    where: { id: data.exerciseId, userId },
  });
  if (!exercise) {
    throw new ApiError(400, 'Invalid exercise.');
  }

  // Cardio cross-field rule (issue #133): duration/distance only on CARDIO
  // exercises, and a cardio set requires a duration.
  const categoryError = validateSetForCategory(exercise.category, data);
  if (categoryError) {
    throw new ApiError(400, categoryError);
  }
  const isCardio = exercise.category === 'CARDIO';

  // Block of a repeated exercise (issue #429): stored only when the
  // session's workout holds this exercise more than once, normalized into
  // range, so a single-occurrence exercise always stores NULL as before.
  const occurrences = session.workoutId
    ? await db.programExercise.count({
        // Ownership in the query scope itself (issue #317): the session is
        // the user's, and so must the workout whose rows are counted.
        where: {
          workoutId: session.workoutId,
          exerciseId: data.exerciseId,
          workout: { program: { userId } },
        },
      })
    : 0;
  const block = occurrences > 1 ? effectiveSetBlock(data.block, occurrences) : null;

  const created = await db.$transaction(async (tx) => {
    const canonicalWeight = isCardio ? 0 : data.weight;
    const equipmentSnapshot = await resolveSetEquipmentSnapshot(tx, {
      userId,
      sessionGymId: session.gymId,
      exerciseId: data.exerciseId,
      gymEquipmentId: data.gymEquipmentId,
    });
    return tx.set.create({
      data: {
        sessionId,
        exerciseId: data.exerciseId,
        ...equipmentSnapshot,
        setNumber: data.setNumber,
        // Cardio sets store weight = 0 / reps = 1 by convention (the columns
        // are NOT NULL); the UI never shows them for CARDIO exercises.
        weight: canonicalWeight,
        reps: isCardio ? 1 : data.reps,
        rir: isCardio ? null : (data.rir ?? null),
        durationSec: isCardio ? data.durationSec : null,
        distanceM: isCardio ? (data.distanceM ?? null) : null,
        avgHr: isCardio ? (data.avgHr ?? null) : null,
        maxHr: isCardio ? (data.maxHr ?? null) : null,
        notes: data.notes ?? null,
        isWarmup: data.isWarmup ?? false,
        isDropSet: data.isDropSet ?? false,
        block,
      },
    });
  });
  // Best-effort: the set is already committed, so a failure here must never
  // fail the request (a 500 would make the offline sync retry the POST and
  // duplicate the set). An unstamped goal self-heals on the next achieving
  // set or on goal re-creation, which re-derives achievedAt from history.
  try {
    await stampGoalIfAchieved(userId, exercise, created);
  } catch (stampErr) {
    console.error('[api] goal achievement stamping failed:', stampErr);
  }
  return created;
}

// Per-exercise goal (issue #90): when a freshly logged working set meets an
// unachieved goal's target, stamp achievedAt with the set's completedAt
// (deterministic - the same instant the goal-creation path would derive).
// Comparison runs on the effective load (bodyweight + added load for
// bodyweight exercises), consistent with lib/stats.
async function stampGoalIfAchieved(userId: string, exercise: Exercise, set: Set): Promise<void> {
  if (set.isWarmup) return;
  const goal = await db.exerciseGoal.findUnique({
    where: { userId_exerciseId: { userId, exerciseId: exercise.id } },
  });
  if (!goal || goal.achievedAt) return;

  let weight = set.weight;
  if (exercise.usesBodyweight) {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { bodyweight: true },
    });
    weight = effectiveWeight(set.weight, true, user?.bodyweight);
  }
  if (setAchievesGoal({ weight, reps: set.reps, isWarmup: set.isWarmup }, goal)) {
    await db.exerciseGoal.update({
      where: { id: goal.id },
      data: { achievedAt: set.completedAt },
    });
  }
}

// Corrects the logged strength values of a set in an open session.
export async function updateOwnedSet(
  userId: string,
  setId: string,
  data: SetUpdateInput,
): Promise<Set> {
  return runSerializableSetTransaction(async (tx) => {
    // Serialize same-set mutations first, then serialize goal re-derivation
    // for the exercise. The set values and derived achievedAt now commit or
    // roll back together instead of leaving a stale goal after a successful edit.
    await tx.$queryRaw`SELECT "Set".id FROM "Set" JOIN "Session" ON "Session".id = "Set"."sessionId" WHERE "Set".id = ${setId} AND "Session"."userId" = ${userId} FOR UPDATE OF "Set"`;
    const set = await tx.set.findFirst({
      where: { id: setId, session: { userId } },
      include: {
        session: { select: { finishedAt: true } },
        exercise: { select: { category: true } },
      },
    });
    if (!set) {
      throw new ApiError(404, 'Set not found.');
    }
    if (set.session.finishedAt) {
      throw new ApiError(400, 'Session already finished.');
    }
    if (set.exercise.category === 'CARDIO') {
      throw new ApiError(400, 'Cardio sets cannot be edited with strength fields.');
    }

    await lockExerciseGoal(tx, userId, set.exerciseId);
    const row = await tx.set.update({
      where: { id: set.id, session: { userId } },
      data: { weight: data.weight, reps: data.reps, rir: data.rir },
    });
    await rederiveGoalAchievement(tx, userId, set.exerciseId, true);
    return row;
  });
}

// Deletes a set (e.g. an input mistake). The user can then re-enter it; value
// corrections use updateOwnedSet.
export async function deleteOwnedSet(userId: string, setId: string): Promise<void> {
  await runSerializableSetTransaction(async (tx) => {
    await tx.$queryRaw`SELECT "Set".id FROM "Set" JOIN "Session" ON "Session".id = "Set"."sessionId" WHERE "Set".id = ${setId} AND "Session"."userId" = ${userId} FOR UPDATE OF "Set"`;
    const set = await tx.set.findFirst({
      where: { id: setId, session: { userId } },
    });
    if (!set) {
      throw new ApiError(404, 'Set not found.');
    }

    await lockExerciseGoal(tx, userId, set.exerciseId);
    await tx.set.delete({ where: { id: setId, session: { userId } } });
    await rederiveGoalAchievement(tx, userId, set.exerciseId, false);
  });
}

const MAX_SERIALIZABLE_ATTEMPTS = 3;

async function runSerializableSetTransaction<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_SERIALIZABLE_ATTEMPTS; attempt += 1) {
    try {
      return await db.$transaction(operation, { isolationLevel: 'Serializable' });
    } catch (err) {
      const isWriteConflict =
        typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2034';
      if (!isWriteConflict || attempt === MAX_SERIALIZABLE_ATTEMPTS) throw err;
    }
  }

  throw new Error('Serializable set transaction retry exhausted.');
}

async function lockExerciseGoal(
  tx: Prisma.TransactionClient,
  userId: string,
  exerciseId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "ExerciseGoal" WHERE "userId" = ${userId} AND "exerciseId" = ${exerciseId} FOR UPDATE`;
}

// A deleted set may have been the one that stamped the exercise's goal as
// achieved (issue #96). Re-derive achievedAt from the remaining sets: clear it
// when nothing meets the target anymore, or re-stamp it with the earliest
// remaining achieving set. Comparison runs on the effective load, consistent
// with the stamping path and lib/stats.
async function rederiveGoalAchievement(
  tx: Prisma.TransactionClient,
  userId: string,
  exerciseId: string,
  allowAchievement: boolean,
): Promise<void> {
  const goal = await tx.exerciseGoal.findUnique({
    where: { userId_exerciseId: { userId, exerciseId } },
  });
  if (!goal || (!allowAchievement && !goal.achievedAt)) return;

  const [exercise, sets] = await Promise.all([
    tx.exercise.findFirst({
      where: { id: exerciseId, userId },
      select: { usesBodyweight: true },
    }),
    tx.set.findMany({
      where: { exerciseId, isWarmup: false, session: { userId } },
      select: { weight: true, reps: true, isWarmup: true, completedAt: true },
    }),
  ]);
  if (!exercise) return;

  let bodyweight: number | null = null;
  if (exercise.usesBodyweight) {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { bodyweight: true },
    });
    bodyweight = user?.bodyweight ?? null;
  }

  const achieving = findAchievingSet(
    sets.map((s) => ({
      ...s,
      weight: effectiveWeight(s.weight, exercise.usesBodyweight, bodyweight),
    })),
    goal,
  );
  const achievedAt = achieving?.completedAt ?? null;
  if (achievedAt?.getTime() !== goal.achievedAt?.getTime()) {
    await tx.exerciseGoal.update({
      where: { id: goal.id },
      data: { achievedAt },
    });
  }
}
