import { NextResponse } from 'next/server';
import { setInputSchema } from '@/lib/schemas/set';
import { handleApiError, parseJsonBody, requireApiUserId } from '@/lib/api';
import { logOwnedSet } from '@/lib/live-session';

interface Params {
  params: Promise<{ id: string }>;
}

// POST /api/sessions/[id]/sets: records a set in a session (lib/live-session.ts).
export async function POST(req: Request, props: Params) {
  const params = await props.params;
  try {
    const userId = await requireApiUserId();
    const data = await parseJsonBody(req, setInputSchema);
    const created = await logOwnedSet(userId, params.id, data);
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
