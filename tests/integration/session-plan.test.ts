import { describe, it, expect, vi, beforeEach } from 'vitest';
import { db } from '@/lib/db';
import { getCurrentUserId } from '@/lib/auth';
import { buildCurrentSessionContext } from '@/lib/coach';
import { getOwnedSessionState } from '@/lib/live-session-state';
import { skipSessionExercise, swapSessionExercise } from '@/lib/session-plan';

// Changing a workout during a session (lib/session-plan.ts). Pinned here: the
// first change made just for today copies the workout onto the session with
// every setting and a link to its program row, the saved program stays as it
// was, the readers (live state, coach snapshot) read the copy, and a change
// made from now on reaches the program too, with or without a copy.

vi.mock('@/lib/auth', () => ({ getCurrentUserId: vi.fn() }));
const mockUserId = vi.mocked(getCurrentUserId);

import { POST as addRow } from '@/app/api/sessions/[id]/exercises/route';
import {
  PUT as putRow,
  PATCH as patchRow,
  DELETE as deleteRow,
} from '@/app/api/sessions/[id]/exercises/[rowId]/route';
import { PUT as putSession } from '@/app/api/sessions/[id]/route';
import { GET as getBackup, POST as postBackup } from '@/app/api/backup/route';

function actAs(userId: string) {
  mockUserId.mockResolvedValue(userId);
}

function jsonReq(method: string, body: unknown, url = 'http://test.local/api'): Request {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function idParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function rowParams(id: string, rowId: string) {
  return { params: Promise.resolve({ id, rowId }) };
}

function del(scope?: string) {
  return new Request('http://test.local/api' + (scope ? '?scope=' + scope : ''), {
    method: 'DELETE',
  });
}

const targets = {
  targetSets: 3,
  targetRepsMin: 8,
  targetRepsMax: 12,
  targetRIR: 2,
  restSec: 90,
};

async function seed(email: string) {
  const user = await db.user.create({ data: { email, passwordHash: 'x' } });
  const ex = async (
    name: string,
    muscleGroup: 'CHEST' | 'BACK_THICKNESS' | 'QUADS' | 'BICEPS',
    category: 'COMPOUND' | 'ISOLATION' = 'COMPOUND',
  ) => db.exercise.create({ data: { userId: user.id, name, muscleGroup, category } });
  const bench = await ex('Bench', 'CHEST');
  const incline = await ex('Incline', 'CHEST');
  const row = await ex('Row', 'BACK_THICKNESS');
  const squat = await ex('Squat', 'QUADS');
  const curl = await ex('Curl', 'BICEPS', 'ISOLATION');
  const program = await db.program.create({ data: { userId: user.id, name: 'P', phase: 'Base' } });
  const workout = await db.workout.create({
    data: { programId: program.id, name: 'Day A', order: 1 },
  });
  const pe = async (exerciseId: string, order: number, extra: object = {}) =>
    db.programExercise.create({
      data: { workoutId: workout.id, exerciseId, order, ...targets, ...extra },
    });
  const peBench = await pe(bench.id, 1, {
    tempo: '3-1-1',
    notes: 'Pause on chest',
    supersetGroup: 1,
    autoregulationMode: 'PRESERVE_REPS',
    fatigueRate: 1.4,
    loadAdjustmentPct: 5,
  });
  const peRow = await pe(row.id, 2, { supersetGroup: 1 });
  const peSquat = await pe(squat.id, 3);
  const session = await db.session.create({
    data: { userId: user.id, workoutId: workout.id, programId: program.id },
  });
  actAs(user.id);
  return { user, bench, incline, row, squat, curl, workout, peBench, peRow, peSquat, session };
}

async function programRows(workoutId: string) {
  return db.programExercise.findMany({ where: { workoutId }, orderBy: { order: 'asc' } });
}

async function copyRows(sessionId: string) {
  return db.sessionExercise.findMany({ where: { sessionId }, orderBy: { order: 'asc' } });
}

beforeEach(() => {
  mockUserId.mockReset();
});

describe('a change made just for today', () => {
  it('copies the workout with every setting, changes the copy and leaves the program', async () => {
    const s = await seed('plan-copy@test.dev');
    const before = await programRows(s.workout.id);

    // The runner names the program row while no copy exists.
    const res = await putRow(
      jsonReq('PUT', { exerciseId: s.incline.id, ...targets, scope: 'today' }),
      rowParams(s.session.id, s.peBench.id),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ exerciseId: s.incline.id, copied: true });

    expect(await programRows(s.workout.id)).toEqual(before);
    const rows = await copyRows(s.session.id);
    expect(rows.map((r) => [r.exerciseId, r.programExerciseId, r.order])).toEqual([
      [s.incline.id, s.peBench.id, 1],
      [s.row.id, s.peRow.id, 2],
      [s.squat.id, s.peSquat.id, 3],
    ]);
    expect(rows[0]).toMatchObject({
      id: body.id,
      tempo: '3-1-1',
      notes: 'Pause on chest',
      supersetGroup: 1,
      autoregulationMode: 'PRESERVE_REPS',
      // Tuned for the old exercise, so reset to the new one's defaults.
      fatigueRate: null,
      loadAdjustmentPct: null,
    });
    expect(rows[1]).toMatchObject({ supersetGroup: 1 });

    const state = await getOwnedSessionState(s.user.id, s.session.id);
    expect(state?.exercises.map((e) => [e.programExerciseId, e.name])).toEqual([
      [rows[0]!.id, 'Incline'],
      [rows[1]!.id, 'Row'],
      [rows[2]!.id, 'Squat'],
    ]);
  });

  it('copies once when two changes arrive together', async () => {
    const s = await seed('plan-race@test.dev');
    const [a, b] = await Promise.all([
      skipSessionExercise(s.user.id, s.session.id, { rowId: s.peSquat.id, skipped: true }),
      swapSessionExercise(s.user.id, s.session.id, {
        rowId: s.peBench.id,
        exerciseId: s.incline.id,
        scope: 'today',
      }),
    ]);
    expect([a.copied, b.copied].filter(Boolean)).toHaveLength(1);
    expect(await copyRows(s.session.id)).toHaveLength(3);
  });

  it('adds after a given row, and refuses an exercise already in the session', async () => {
    const s = await seed('plan-add@test.dev');
    const { addSessionExercise } = await import('@/lib/session-plan');
    const change = await addSessionExercise(s.user.id, s.session.id, {
      exerciseId: s.curl.id,
      scope: 'today',
      afterRowId: s.peBench.id,
    });
    const rows = await copyRows(s.session.id);
    expect(rows.map((r) => r.exerciseId)).toEqual([s.bench.id, s.curl.id, s.row.id, s.squat.id]);
    expect(rows.map((r) => r.order)).toEqual([1, 2, 3, 4]);
    expect(rows[1]).toMatchObject({ id: change.rowId, programExerciseId: null });
    expect(await programRows(s.workout.id)).toHaveLength(3);

    const dup = await addRow(
      jsonReq('POST', { exerciseId: s.row.id, ...targets }),
      idParams(s.session.id),
    );
    expect(dup.status).toBe(409);
  });

  it('removes from the copy only, and keeps the last exercise', async () => {
    const s = await seed('plan-remove@test.dev');
    expect((await deleteRow(del('today'), rowParams(s.session.id, s.peRow.id))).status).toBe(200);
    expect((await copyRows(s.session.id)).map((r) => r.exerciseId)).toEqual([
      s.bench.id,
      s.squat.id,
    ]);
    expect(await programRows(s.workout.id)).toHaveLength(3);

    const rows = await copyRows(s.session.id);
    await deleteRow(del(), rowParams(s.session.id, rows[0]!.id));
    const last = await deleteRow(del(), rowParams(s.session.id, rows[1]!.id));
    expect(last.status).toBe(409);
    expect(await copyRows(s.session.id)).toHaveLength(1);
  });
});

describe('a change made from now on', () => {
  it('edits only the program while the session has no copy', async () => {
    const s = await seed('plan-program@test.dev');
    const res = await putRow(
      jsonReq('PUT', { exerciseId: s.incline.id, ...targets, scope: 'program' }),
      rowParams(s.session.id, s.peBench.id),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: s.peBench.id, copied: false });
    const program = await programRows(s.workout.id);
    expect(program[0]).toMatchObject({
      exerciseId: s.incline.id,
      tempo: '3-1-1',
      fatigueRate: null,
    });
    expect(await copyRows(s.session.id)).toHaveLength(0);

    const added = await addRow(
      jsonReq('POST', { exerciseId: s.curl.id, ...targets, scope: 'program' }),
      idParams(s.session.id),
    );
    expect(added.status).toBe(201);
    expect((await programRows(s.workout.id)).map((r) => r.exerciseId)).toEqual([
      s.incline.id,
      s.row.id,
      s.squat.id,
      s.curl.id,
    ]);
    expect(await copyRows(s.session.id)).toHaveLength(0);
  });

  it('edits the copy and the program row it came from once a copy exists', async () => {
    const s = await seed('plan-both@test.dev');
    await deleteRow(del('today'), rowParams(s.session.id, s.peSquat.id));
    const [bench] = await copyRows(s.session.id);

    await putRow(
      jsonReq('PUT', { exerciseId: s.incline.id, ...targets, scope: 'program' }),
      rowParams(s.session.id, bench!.id),
    );
    await addRow(
      jsonReq('POST', { exerciseId: s.curl.id, ...targets, scope: 'program' }),
      idParams(s.session.id),
    );
    await deleteRow(del('program'), rowParams(s.session.id, s.peRow.id));

    // The squat removed just for today is still in the program.
    expect((await programRows(s.workout.id)).map((r) => r.exerciseId)).toEqual([
      s.incline.id,
      s.squat.id,
      s.curl.id,
    ]);
    const copy = await copyRows(s.session.id);
    expect(copy.map((r) => r.exerciseId)).toEqual([s.incline.id, s.curl.id]);
    const program = await programRows(s.workout.id);
    expect(copy[1]!.programExerciseId).toBe(program[2]!.id);
  });

  it('refuses a duplicate in the program without changing anything', async () => {
    const s = await seed('plan-dup@test.dev');
    const res = await putRow(
      jsonReq('PUT', { exerciseId: s.row.id, ...targets, scope: 'program' }),
      rowParams(s.session.id, s.peBench.id),
    );
    expect(res.status).toBe(409);
    expect((await programRows(s.workout.id))[0]!.exerciseId).toBe(s.bench.id);
  });
});

describe('skipping an exercise', () => {
  it('takes it off the plan, keeps it on record, and can be taken back', async () => {
    const s = await seed('plan-skip@test.dev');
    const res = await patchRow(
      jsonReq('PATCH', { skipped: true }),
      rowParams(s.session.id, s.peBench.id),
    );
    expect(res.status).toBe(200);
    const skipped = (await copyRows(s.session.id))[0]!;
    expect(skipped.skippedAt).toBeInstanceOf(Date);

    const state = await getOwnedSessionState(s.user.id, s.session.id);
    expect(state?.exercises.map((e) => e.name)).toEqual(['Row', 'Squat']);
    const context = await buildCurrentSessionContext(s.user.id, s.session.id);
    expect(context?.exercises.map((e) => e.exerciseName)).toEqual(['Row', 'Squat']);

    await patchRow(jsonReq('PATCH', { skipped: false }), rowParams(s.session.id, skipped.id));
    expect((await copyRows(s.session.id))[0]!.skippedAt).toBeNull();
  });

  it('refuses to skip the last exercise left', async () => {
    const s = await seed('plan-skip-last@test.dev');
    await patchRow(jsonReq('PATCH', { skipped: true }), rowParams(s.session.id, s.peBench.id));
    await patchRow(jsonReq('PATCH', { skipped: true }), rowParams(s.session.id, s.peRow.id));
    const last = await patchRow(
      jsonReq('PATCH', { skipped: true }),
      rowParams(s.session.id, s.peSquat.id),
    );
    expect(last.status).toBe(409);
  });
});

describe('guards', () => {
  it("answers 404 on another user's session and 400 on a finished one", async () => {
    const s = await seed('plan-owner@test.dev');
    const other = await db.user.create({
      data: { email: 'plan-other@test.dev', passwordHash: 'x' },
    });
    actAs(other.id);
    const stranger = await putRow(
      jsonReq('PUT', { exerciseId: s.incline.id, ...targets }),
      rowParams(s.session.id, s.peBench.id),
    );
    expect(stranger.status).toBe(404);
    expect(await copyRows(s.session.id)).toHaveLength(0);

    actAs(s.user.id);
    await putSession(jsonReq('PUT', { finish: true }), idParams(s.session.id));
    const finished = await patchRow(
      jsonReq('PATCH', { skipped: true }),
      rowParams(s.session.id, s.peBench.id),
    );
    expect(finished.status).toBe(400);
  });

  it('rejects an unknown scope', async () => {
    const s = await seed('plan-scope@test.dev');
    expect((await deleteRow(del('forever'), rowParams(s.session.id, s.peBench.id))).status).toBe(
      400,
    );
    const put = await putRow(
      jsonReq('PUT', { exerciseId: s.incline.id, ...targets, scope: 'forever' }),
      rowParams(s.session.id, s.peBench.id),
    );
    expect(put.status).toBe(400);
  });

  it('copies a workout that repeats an exercise on purpose (issue #429)', async () => {
    const s = await seed('plan-repeat@test.dev');
    await db.programExercise.create({
      data: { workoutId: s.workout.id, exerciseId: s.bench.id, order: 4, ...targets },
    });
    const res = await patchRow(
      jsonReq('PATCH', { skipped: true }),
      rowParams(s.session.id, s.peSquat.id),
    );
    expect(res.status).toBe(200);
    expect((await copyRows(s.session.id)).map((r) => r.exerciseId)).toEqual([
      s.bench.id,
      s.row.id,
      s.squat.id,
      s.bench.id,
    ]);
  });
});

describe('backup of a copied workout (v15)', () => {
  it('round-trips the copy with its settings and skip marker into another account', async () => {
    const s = await seed('plan-backup@test.dev');
    await patchRow(jsonReq('PATCH', { skipped: true }), rowParams(s.session.id, s.peSquat.id));
    await putSession(jsonReq('PUT', { finish: true }), idParams(s.session.id));

    const backup = await (await getBackup()).json();
    const exported = backup.sessions[0].exercises;
    expect(exported).toHaveLength(3);
    expect(exported[0]).toMatchObject({ exerciseName: 'Bench', tempo: '3-1-1', supersetGroup: 1 });
    expect(exported[2].skippedAt).toEqual(expect.any(String));

    const target = await db.user.create({
      data: { email: 'plan-restore@test.dev', passwordHash: 'x' },
    });
    actAs(target.id);
    const res = await postBackup(jsonReq('POST', { payload: backup, confirmReplace: true }));
    expect(res.status).toBe(200);
    const restored = await db.session.findFirstOrThrow({
      where: { userId: target.id },
      include: { exercises: { orderBy: { order: 'asc' }, include: { exercise: true } } },
    });
    expect(restored.workoutId).not.toBeNull();
    expect(restored.exercises.map((r) => [r.exercise.name, r.skippedAt != null])).toEqual([
      ['Bench', false],
      ['Row', false],
      ['Squat', true],
    ]);
    expect(restored.exercises[0]).toMatchObject({
      tempo: '3-1-1',
      notes: 'Pause on chest',
      autoregulationMode: 'PRESERVE_REPS',
      fatigueRate: 1.4,
      programExerciseId: null,
    });
  });
});
