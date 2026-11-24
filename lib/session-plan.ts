import type { Exercise, Prisma, SessionExercise } from '@/lib/prisma-client';
import { db } from '@/lib/db';
import { ApiError } from '@/lib/api';
import { isCardioExercise } from '@/lib/cardio-target';
import { addedExerciseTargets, toRunnerExercises, type RunnerExercise } from '@/lib/freestyle';

// The exercise list of one session, and the changes a lifter makes to it while
// training. A session run from a workout reads the workout's rows until the
// first change made "just for today": the rows are then copied onto the
// session (SessionExercise, linked to their program row) and the session reads
// its copy from then on, so the saved program stays as it was. A change made
// "from now on" edits the program too. A freestyle session (issue #388) always
// reads its own list and has no program to edit.

export type PlanScope = 'today' | 'program';

type Tx = Prisma.TransactionClient;
type CopyRow = SessionExercise & { exercise: Exercise };

// The rows a session runs: its own list when it has one (freestyle, or a
// workout changed for today), else the workout's. Skipped rows are left out.
export function sessionPlanRows(session: {
  workout: { exercises: RunnerExercise[] } | null;
  exercises: CopyRow[];
}): RunnerExercise[] {
  if (session.workout && session.exercises.length === 0) return session.workout.exercises;
  return toRunnerExercises(session.exercises.filter((row) => row.skippedAt == null));
}

export interface PlanChange {
  // Id of the row the change produced or touched, as the runner and the live
  // state now name it (a session row once a copy exists, else a program row).
  rowId: string | null;
  copied: boolean;
}

interface LockedSession {
  id: string;
  workoutId: string | null;
  freestyle: boolean;
}

// Locks the session row for the rest of the transaction, so two changes sent
// together cannot both copy the workout.
async function lockOpenSession(tx: Tx, userId: string, sessionId: string): Promise<LockedSession> {
  await tx.$queryRaw`SELECT id FROM "Session" WHERE id = ${sessionId} AND "userId" = ${userId} FOR UPDATE`;
  const session = await tx.session.findFirst({
    where: { id: sessionId, userId },
    select: { id: true, workoutId: true, freestyle: true, finishedAt: true },
  });
  if (!session) throw new ApiError(404, 'Session not found.');
  if (session.finishedAt) throw new ApiError(400, 'Session already finished.');
  return session;
}

function copyRows(tx: Tx, sessionId: string) {
  return tx.sessionExercise.findMany({
    where: { sessionId },
    orderBy: { order: 'asc' },
    include: { exercise: true },
  });
}

// Copies the workout's rows onto the session once; later calls return the
// copy. A session without a workout returns its own list as it is.
async function ensureCopy(
  tx: Tx,
  session: LockedSession,
): Promise<{ rows: CopyRow[]; copied: boolean }> {
  const rows = await copyRows(tx, session.id);
  if (rows.length > 0 || !session.workoutId) return { rows, copied: false };
  const source = await tx.programExercise.findMany({
    where: { workoutId: session.workoutId },
    orderBy: { order: 'asc' },
  });
  if (source.length === 0) return { rows, copied: false };
  await tx.sessionExercise.createMany({
    data: source.map((pe, index) => ({
      sessionId: session.id,
      exerciseId: pe.exerciseId,
      order: index + 1,
      targetSets: pe.targetSets,
      targetRepsMin: pe.targetRepsMin,
      targetRepsMax: pe.targetRepsMax,
      targetRIR: pe.targetRIR,
      restSec: pe.restSec,
      programExerciseId: pe.id,
      tempo: pe.tempo,
      notes: pe.notes,
      supersetGroup: pe.supersetGroup,
      autoregulationMode: pe.autoregulationMode,
      fatigueRate: pe.fatigueRate,
      loadAdjustmentPct: pe.loadAdjustmentPct,
      targetDurationSec: pe.targetDurationSec,
      targetDistanceM: pe.targetDistanceM,
    })),
  });
  return { rows: await copyRows(tx, session.id), copied: true };
}

// A row id from the runner or the live state names a session row, or, before
// the copy existed, the program row it was copied from.
function findRow(rows: CopyRow[], rowId: string): CopyRow {
  const row = rows.find((r) => r.id === rowId) ?? rows.find((r) => r.programExerciseId === rowId);
  if (!row) throw new ApiError(404, 'Session exercise not found.');
  return row;
}

async function ownedExercise(tx: Tx, userId: string, exerciseId: string) {
  const exercise = await tx.exercise.findFirst({ where: { id: exerciseId, userId } });
  if (!exercise) throw new ApiError(400, 'Invalid exercise.');
  return exercise;
}

// One row per exercise, as in a workout (issue #379): a Set carries only an
// exerciseId, so two rows of the same exercise would share one set pool.
function refuseDuplicate(rows: CopyRow[], exerciseId: string, exceptId?: string) {
  if (rows.some((r) => r.exerciseId === exerciseId && r.id !== exceptId && r.skippedAt == null)) {
    throw new ApiError(409, 'That exercise is already in this session.');
  }
}

async function refuseProgramDuplicate(
  tx: Tx,
  workoutId: string,
  exerciseId: string,
  exceptId?: string,
) {
  const duplicate = await tx.programExercise.findFirst({
    where: { workoutId, exerciseId, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (duplicate) throw new ApiError(409, 'That exercise is already in this workout.');
}

export type Targets = Pick<
  SessionExercise,
  'targetSets' | 'targetRepsMin' | 'targetRepsMax' | 'targetRIR' | 'restSec'
>;

// What a swapped row becomes: the targets sent, or else the row's when both
// exercises are of the same kind (strength or cardio), else the new
// exercise's defaults. The fatigue rate and load step were tuned for the old
// exercise, so they go back to NULL (the new exercise's defaults); a row that
// keeps its exercise keeps them.
function swappedFields(
  row: Targets & {
    exerciseId: string;
    fatigueRate: number | null;
    loadAdjustmentPct: number | null;
    exercise: Pick<Exercise, 'category'>;
    targetDurationSec: number | null;
    targetDistanceM: number | null;
  },
  exercise: Exercise,
  sent?: Targets,
) {
  const sameKind = isCardioExercise(row.exercise) === isCardioExercise(exercise);
  const targets = sent
    ? sent
    : sameKind
      ? {
          targetSets: row.targetSets,
          targetRepsMin: row.targetRepsMin,
          targetRepsMax: row.targetRepsMax,
          targetRIR: row.targetRIR,
          restSec: row.restSec,
        }
      : addedExerciseTargets(exercise);
  const cardio = isCardioExercise(exercise);
  return {
    exerciseId: exercise.id,
    targetSets: targets.targetSets,
    targetRepsMin: targets.targetRepsMin,
    targetRepsMax: targets.targetRepsMax,
    targetRIR: targets.targetRIR,
    restSec: targets.restSec,
    fatigueRate: row.exerciseId === exercise.id ? row.fatigueRate : null,
    loadAdjustmentPct: row.exerciseId === exercise.id ? row.loadAdjustmentPct : null,
    targetDurationSec: cardio && sameKind ? row.targetDurationSec : null,
    targetDistanceM: cardio && sameKind ? row.targetDistanceM : null,
  };
}

function scopeOf(session: LockedSession, scope: PlanScope): PlanScope {
  return session.workoutId ? scope : 'today';
}

// Replaces the exercise on one row. "from now on" also replaces it on the
// program row the session row came from.
export function swapSessionExercise(
  userId: string,
  sessionId: string,
  input: { rowId: string; exerciseId: string; scope: PlanScope; targets?: Targets },
): Promise<PlanChange> {
  return db.$transaction(async (tx) => {
    const session = await lockOpenSession(tx, userId, sessionId);
    const scope = scopeOf(session, input.scope);
    const exercise = await ownedExercise(tx, userId, input.exerciseId);

    const existing = await copyRows(tx, session.id);
    if (scope === 'program' && existing.length === 0) {
      // No copy yet: the session reads the program, so editing it is enough.
      const pe = await tx.programExercise.findFirst({
        where: { id: input.rowId, workoutId: session.workoutId!, workout: { program: { userId } } },
        include: { exercise: true },
      });
      if (!pe) throw new ApiError(404, 'Session exercise not found.');
      if (pe.exerciseId !== exercise.id) {
        await refuseProgramDuplicate(tx, pe.workoutId, exercise.id, pe.id);
      }
      await tx.programExercise.update({
        where: { id: pe.id },
        data: swappedFields(pe, exercise, input.targets),
      });
      return { rowId: pe.id, copied: false };
    }

    const { rows, copied } = await ensureCopy(tx, session);
    const row = findRow(rows, input.rowId);
    if (row.exerciseId !== exercise.id) refuseDuplicate(rows, exercise.id, row.id);
    const fields = swappedFields(row, exercise, input.targets);
    if (scope === 'program' && row.programExerciseId) {
      await refuseProgramDuplicate(tx, session.workoutId!, exercise.id, row.programExerciseId);
      await tx.programExercise.update({ where: { id: row.programExerciseId }, data: fields });
    }
    await tx.sessionExercise.update({ where: { id: row.id }, data: fields });
    return { rowId: row.id, copied };
  });
}

// Adds an exercise with the targets sent, or the defaults of a freshly added
// row, after `afterRowId`
// or at the end. "from now on" adds it at the end of the workout too.
export function addSessionExercise(
  userId: string,
  sessionId: string,
  input: { exerciseId: string; scope: PlanScope; afterRowId?: string; targets?: Targets },
): Promise<PlanChange> {
  return db.$transaction(async (tx) => {
    const session = await lockOpenSession(tx, userId, sessionId);
    const scope = scopeOf(session, input.scope);
    const exercise = await ownedExercise(tx, userId, input.exerciseId);
    const targets = {
      ...(input.targets ?? addedExerciseTargets(exercise)),
      exerciseId: exercise.id,
    };

    let programRowId: string | null = null;
    if (scope === 'program') {
      await refuseProgramDuplicate(tx, session.workoutId!, exercise.id);
      const last = await tx.programExercise.findFirst({
        where: { workoutId: session.workoutId! },
        orderBy: { order: 'desc' },
        select: { order: true },
      });
      const created = await tx.programExercise.create({
        data: { ...targets, workoutId: session.workoutId!, order: (last?.order ?? 0) + 1 },
      });
      programRowId = created.id;
      // No copy yet: the session reads the program, which now has the row.
      if (!input.afterRowId && (await copyRows(tx, session.id)).length === 0) {
        return { rowId: programRowId, copied: false };
      }
    }

    const { rows, copied } = await ensureCopy(tx, session);
    // A row the copy just took from the program is the one added above.
    const fromCopy = programRowId
      ? rows.find((r) => r.programExerciseId === programRowId)
      : undefined;
    if (!fromCopy) refuseDuplicate(rows, exercise.id);
    const after = input.afterRowId ? findRow(rows, input.afterRowId) : undefined;
    const order = after ? after.order + 1 : (rows.at(-1)?.order ?? 0) + 1;
    if (after) {
      await tx.sessionExercise.updateMany({
        where: {
          sessionId: session.id,
          order: { gte: order },
          ...(fromCopy ? { id: { not: fromCopy.id } } : {}),
        },
        data: { order: { increment: 1 } },
      });
    }
    if (fromCopy) {
      await tx.sessionExercise.update({ where: { id: fromCopy.id }, data: { order } });
      return { rowId: fromCopy.id, copied };
    }
    const created = await tx.sessionExercise.create({
      data: { ...targets, sessionId: session.id, order, programExerciseId: programRowId },
    });
    return { rowId: created.id, copied };
  });
}

// Takes an exercise off the list. Sets already logged stay in the session.
// "from now on" also deletes the program row. A session run from a workout
// keeps at least one exercise, since the runner has no empty state for it.
export function removeSessionExercise(
  userId: string,
  sessionId: string,
  input: { rowId: string; scope: PlanScope },
): Promise<PlanChange> {
  return db.$transaction(async (tx) => {
    const session = await lockOpenSession(tx, userId, sessionId);
    const scope = scopeOf(session, input.scope);

    const existing = await copyRows(tx, session.id);
    if (scope === 'program' && existing.length === 0) {
      const pe = await tx.programExercise.findFirst({
        where: { id: input.rowId, workoutId: session.workoutId!, workout: { program: { userId } } },
        select: { id: true },
      });
      if (!pe) throw new ApiError(404, 'Session exercise not found.');
      const count = await tx.programExercise.count({ where: { workoutId: session.workoutId! } });
      if (count <= 1) throw new ApiError(409, 'The last exercise of a workout cannot be removed.');
      await tx.programExercise.delete({ where: { id: pe.id } });
      return { rowId: null, copied: false };
    }

    const { rows, copied } = await ensureCopy(tx, session);
    const row = findRow(rows, input.rowId);
    const active = rows.filter((r) => r.skippedAt == null);
    if (session.workoutId && active.length <= 1 && row.skippedAt == null) {
      throw new ApiError(409, 'The last exercise of a workout cannot be removed.');
    }
    await tx.sessionExercise.delete({ where: { id: row.id } });
    if (scope === 'program' && row.programExerciseId) {
      await tx.programExercise.delete({ where: { id: row.programExerciseId } });
    }
    return { rowId: null, copied };
  });
}

// Skips an exercise for this session only (or takes the skip back). The row
// stays on record with its time, so the coach can see what was skipped. The
// last exercise left cannot be skipped: that is finishing the workout.
export function skipSessionExercise(
  userId: string,
  sessionId: string,
  input: { rowId: string; skipped: boolean },
): Promise<PlanChange> {
  return db.$transaction(async (tx) => {
    const session = await lockOpenSession(tx, userId, sessionId);
    const { rows, copied } = await ensureCopy(tx, session);
    const row = findRow(rows, input.rowId);
    if (input.skipped && row.skippedAt == null) {
      if (rows.filter((r) => r.skippedAt == null).length <= 1) {
        throw new ApiError(409, 'That is the last exercise left. Finish the session instead.');
      }
      await tx.sessionExercise.update({ where: { id: row.id }, data: { skippedAt: new Date() } });
    } else if (!input.skipped && row.skippedAt != null) {
      refuseDuplicate(rows, row.exerciseId, row.id);
      await tx.sessionExercise.update({ where: { id: row.id }, data: { skippedAt: null } });
    }
    return { rowId: row.id, copied };
  });
}

// The row a change produced, as the routes return it: a session row with its
// exercise, or the program row when only the program changed. `copied` says
// the workout was copied by this change, so row ids the client holds changed.
export async function planRowJson(change: PlanChange) {
  if (!change.rowId) return { copied: change.copied };
  const row =
    (await db.sessionExercise.findUnique({
      where: { id: change.rowId },
      include: { exercise: true },
    })) ??
    (await db.programExercise.findUnique({
      where: { id: change.rowId },
      include: { exercise: true },
    }));
  return { ...row, copied: change.copied };
}
