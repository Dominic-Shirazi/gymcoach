import { NextResponse } from 'next/server';
import { handleApiError, parseJsonBody, requireApiUserId } from '@/lib/api';
import { deleteOwnedSet, updateOwnedSet } from '@/lib/live-session';
import { setUpdateSchema } from '@/lib/schemas/set';

interface Params {
  params: Promise<{ id: string }>;
}

// PATCH /api/sets/[id]: correct logged strength values in place
// (lib/live-session.ts).
export async function PATCH(req: Request, props: Params) {
  const params = await props.params;
  try {
    const userId = await requireApiUserId();
    const data = await parseJsonBody(req, setUpdateSchema);
    const updated = await updateOwnedSet(userId, params.id, data);
    return NextResponse.json(updated);
  } catch (err) {
    return handleApiError(err);
  }
}

// DELETE /api/sets/[id]: deletes a set (e.g. an input mistake).
// The user can then re-enter it; value corrections use PATCH above.
export async function DELETE(_req: Request, props: Params) {
  const params = await props.params;
  try {
    const userId = await requireApiUserId();
    await deleteOwnedSet(userId, params.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}
