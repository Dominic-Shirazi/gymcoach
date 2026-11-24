import { NextResponse } from 'next/server';
import {
  sessionExerciseChangeSchema,
  sessionExerciseDeleteQuerySchema,
  sessionExerciseSkipSchema,
} from '@/lib/schemas/session';
import { ApiError, handleApiError, parseJsonBody, requireApiUserId } from '@/lib/api';
import {
  planRowJson,
  removeSessionExercise,
  skipSessionExercise,
  swapSessionExercise,
} from '@/lib/session-plan';

interface Params {
  params: Promise<{ id: string; rowId: string }>;
}

// Ownership is part of every query (issue #317): the session is looked up
// through its user and the row through its session, so a stranger's ids
// yield 404. `rowId` is a row of the session's list, or, while a workout
// session has no copy yet, the workout row the runner shows
// (lib/session-plan.ts).

// PUT /api/sessions/[id]/exercises/[rowId]: replaces the exercise (and its
// targets) on one row. The row keeps its place in the list. `scope`
// "program" also replaces it in the workout ("from now on").
export async function PUT(req: Request, props: Params) {
  const params = await props.params;
  try {
    const userId = await requireApiUserId();
    const { exerciseId, scope, ...targets } = await parseJsonBody(req, sessionExerciseChangeSchema);
    const change = await swapSessionExercise(userId, params.id, {
      rowId: params.rowId,
      exerciseId,
      scope,
      targets,
    });
    return NextResponse.json(await planRowJson(change));
  } catch (err) {
    return handleApiError(err);
  }
}

// PATCH /api/sessions/[id]/exercises/[rowId]: skips the exercise for this
// session (`skipped: true`) or takes the skip back. The row stays on record.
export async function PATCH(req: Request, props: Params) {
  const params = await props.params;
  try {
    const userId = await requireApiUserId();
    const { skipped } = await parseJsonBody(req, sessionExerciseSkipSchema);
    const change = await skipSessionExercise(userId, params.id, { rowId: params.rowId, skipped });
    return NextResponse.json(await planRowJson(change));
  } catch (err) {
    return handleApiError(err);
  }
}

// DELETE /api/sessions/[id]/exercises/[rowId]: takes an exercise off the
// list. Sets already logged stay in the session. `?scope=program` also
// deletes it from the workout ("from now on").
export async function DELETE(req: Request, props: Params) {
  const params = await props.params;
  try {
    const userId = await requireApiUserId();
    const query = sessionExerciseDeleteQuerySchema.safeParse(
      Object.fromEntries(new URL(req.url).searchParams),
    );
    if (!query.success) throw new ApiError(400, 'Invalid scope.');
    const change = await removeSessionExercise(userId, params.id, {
      rowId: params.rowId,
      scope: query.data.scope,
    });
    return NextResponse.json({ ok: true, copied: change.copied });
  } catch (err) {
    return handleApiError(err);
  }
}
