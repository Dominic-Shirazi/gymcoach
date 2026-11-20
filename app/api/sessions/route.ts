import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { sessionStartSchema } from '@/lib/schemas/session';
import { handleApiError, parseJsonBody, requireApiUserId } from '@/lib/api';
import { startOwnedSession } from '@/lib/live-session';

export async function GET() {
  try {
    const userId = await requireApiUserId();
    const sessions = await db.session.findMany({
      where: { userId },
      orderBy: { startedAt: 'desc' },
      include: {
        workout: { select: { name: true } },
        program: { select: { name: true } },
        _count: { select: { sets: true } },
      },
      take: 50,
    });
    return NextResponse.json(sessions);
  } catch (err) {
    return handleApiError(err);
  }
}

// POST /api/sessions: starts a new session on one of the user's workouts, or a
// freestyle session when no workout is given (issue #388). An unfinished
// session on the same workout is returned (200) instead of a second one
// (lib/live-session.ts).
export async function POST(req: Request) {
  try {
    const userId = await requireApiUserId();
    const input = await parseJsonBody(req, sessionStartSchema);
    const { session, created } = await startOwnedSession(userId, input);
    return NextResponse.json(session, { status: created ? 201 : 200 });
  } catch (err) {
    return handleApiError(err);
  }
}
