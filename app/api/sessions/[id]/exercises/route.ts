import { NextResponse } from 'next/server';
import { sessionExerciseChangeSchema } from '@/lib/schemas/session';
import { handleApiError, parseJsonBody, requireApiUserId } from '@/lib/api';
import { addSessionExercise, planRowJson } from '@/lib/session-plan';

interface Params {
  params: Promise<{ id: string }>;
}

// POST /api/sessions/[id]/exercises: adds an exercise to an open session's
// list (lib/session-plan.ts). A freestyle session (issue #388) owns its list.
// A session run from a workout copies the workout first and changes the copy,
// so no saved program changes, unless `scope` is "program" ("from now on"),
// which adds the exercise to the workout too. The order is computed.
export async function POST(req: Request, props: Params) {
  const params = await props.params;
  try {
    const userId = await requireApiUserId();
    const { exerciseId, scope, ...targets } = await parseJsonBody(req, sessionExerciseChangeSchema);
    const change = await addSessionExercise(userId, params.id, { exerciseId, scope, targets });
    return NextResponse.json(await planRowJson(change), { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
