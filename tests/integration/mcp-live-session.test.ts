import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { createGymCoachMcpServer } from '@/lib/mcp/server';
import { lbToKg } from '@/lib/units';

// The live-session MCP tools a voice coach drives during a workout. They write
// through lib/live-session.ts like the REST routes, so these tests check the
// tool contract (targets, units, notes, ownership, write gating) on a real
// database. Set parsing runs on the deterministic demo provider.

const savedProvider = process.env.LLM_PROVIDER;
beforeAll(() => {
  process.env.LLM_PROVIDER = 'demo';
});
afterAll(() => {
  if (savedProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = savedProvider;
});

const servers: Array<ReturnType<typeof createGymCoachMcpServer>> = [];
const clients: Client[] = [];

async function connect(userId: string, canWrite = true) {
  const server = createGymCoachMcpServer({
    principal: { tokenId: `token-${userId}-${canWrite}`, userId, canWrite },
    baseUrl: 'https://gymcoach.example',
  });
  const client = new Client({ name: 'live-session-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  servers.push(server);
  clients.push(client);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
});

interface SetView {
  setId: string;
  setNumber: number;
  weightKg: number;
  weight: number;
  reps: number;
  rir: number | null;
  notes: string | null;
}

interface State {
  ok?: boolean;
  created?: boolean;
  session: { id: string; startedAt: string; finishedAt: string | null; notes: string | null } | null;
  unit: string;
  currentExerciseIndex: number | null;
  nextSet: {
    programExerciseId: string;
    exerciseName: string;
    setNumber: number;
    weightKg: number | null;
    weight: number | null;
    reps: number | null;
    rir: number | null;
    toFailure: boolean;
    restSec: number;
  } | null;
  lastSet: SetView | null;
  rest: { endsAt: string; remainingSec: number } | null;
  exercises: Array<{
    programExerciseId: string;
    name: string;
    toFailure: boolean;
    formCue: string | null;
    workingSetsDone: number;
    complete: boolean;
    sets: SetView[];
    lastTime: {
      sessionStartedAt: string;
      sets: Array<{ weight: number; reps: number; rir: number | null }>;
    } | null;
  }>;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) {
    const text = (res.content as Array<{ text?: string }>)[0]?.text ?? '';
    throw new Error(text);
  }
  return res.structuredContent as unknown as State;
}

async function seed(email: string) {
  const user = await db.user.create({ data: { email, passwordHash: 'x', unit: 'LB' } });
  const press = await db.exercise.create({
    data: {
      userId: user.id,
      name: 'Seated dumbbell overhead press',
      muscleGroup: 'SHOULDERS_FRONT',
      category: 'COMPOUND',
      equipmentType: 'DUMBBELL',
      notes: 'Brace, press straight up, no back arch.',
    },
  });
  const curl = await db.exercise.create({
    data: {
      userId: user.id,
      name: 'Hammer curl',
      muscleGroup: 'BICEPS',
      category: 'ISOLATION',
      equipmentType: 'DUMBBELL',
    },
  });
  const program = await db.program.create({
    data: { userId: user.id, name: 'Home', phase: 'Hypertrophy', isActive: true },
  });
  const workout = await db.workout.create({
    data: {
      programId: program.id,
      name: 'Upper',
      order: 0,
      exercises: {
        create: [
          {
            exerciseId: press.id,
            order: 0,
            targetSets: 2,
            targetRepsMin: 6,
            targetRepsMax: 10,
            targetRIR: 2,
            restSec: 120,
          },
          {
            exerciseId: curl.id,
            order: 1,
            targetSets: 1,
            targetRepsMin: 8,
            targetRepsMax: 12,
            targetRIR: 0,
            restSec: 60,
          },
        ],
      },
    },
  });
  return { user, press, curl, workout };
}

describe('GymCoach MCP live session', () => {
  it('starts, announces targets, logs, corrects, deletes and finishes a session', async () => {
    const { user, workout } = await seed('mcp-live-owner@test.dev');
    const client = await connect(user.id);

    // Nothing in progress yet.
    expect((await call(client, 'get_session_state')).session).toBeNull();

    const started = await call(client, 'start_session', { workoutId: workout.id });
    expect(started.created).toBe(true);
    const sessionId = started.session!.id;
    expect(started.unit).toBe('lb');
    expect(started.currentExerciseIndex).toBe(0);
    expect(started.exercises[0]).toMatchObject({
      name: 'Seated dumbbell overhead press',
      formCue: 'Brace, press straight up, no back arch.',
      toFailure: false,
      complete: false,
    });
    expect(started.exercises[1]!.toFailure).toBe(true);
    // No history: the logger's default, middle of the range at the target RIR.
    expect(started.nextSet).toMatchObject({
      exerciseName: 'Seated dumbbell overhead press',
      setNumber: 1,
      weightKg: 0,
      reps: 8,
      rir: 2,
      toFailure: false,
      restSec: 120,
    });

    // A second start resumes the same session.
    const resumed = await call(client, 'start_session', { workoutId: workout.id });
    expect(resumed.created).toBe(false);
    expect(resumed.session!.id).toBe(sessionId);

    // A structured set in the trainee's unit (lb) is stored in kg.
    const logged = await call(client, 'log_set', { weight: 40, reps: 6, rir: 1 });
    expect(logged.lastSet).toMatchObject({ setNumber: 1, reps: 6, rir: 1, weight: 40 });
    expect(logged.lastSet!.weightKg).toBeCloseTo(lbToKg(40), 5);
    expect(logged.exercises[0]!.workingSetsDone).toBe(1);
    expect(logged.nextSet).toMatchObject({
      setNumber: 2,
      exerciseName: 'Seated dumbbell overhead press',
    });
    // The intra-set recommendation keeps the logged load in range.
    expect(logged.nextSet!.weightKg).toBeGreaterThan(0);
    expect(logged.rest?.remainingSec).toBeGreaterThan(0);

    // A spoken set is parsed (demo: 100 x 8 at RIR 2) and keeps its words.
    const spoken = 'did eight at a hundred, left shoulder felt off';
    const fromText = (await call(client, 'log_set_from_text', { text: spoken })) as State & {
      parsed: unknown;
    };
    expect(fromText.parsed).toEqual({ kind: 'strength', weight: 100, reps: 8, rir: 2 });
    expect(fromText.lastSet).toMatchObject({ setNumber: 2, reps: 8, rir: 2, notes: spoken });
    expect(fromText.lastSet!.weightKg).toBeCloseTo(lbToKg(100), 5);
    // Two working sets done: the curl (to failure) is now current.
    expect(fromText.exercises[0]!.complete).toBe(true);
    expect(fromText.nextSet).toMatchObject({ exerciseName: 'Hammer curl', toFailure: true });

    // Text that is not a set logs nothing.
    await expect(call(client, 'log_set_from_text', { text: 'UNPARSEABLE' })).rejects.toThrow(
      /Nothing was logged/,
    );
    expect(await db.set.count({ where: { sessionId } })).toBe(2);

    // Correct the last set: only the given field changes.
    const edited = await call(client, 'edit_last_set', { reps: 7 });
    expect(edited.lastSet).toMatchObject({ setNumber: 2, reps: 7, rir: 2 });
    expect(edited.lastSet!.weightKg).toBeCloseTo(lbToKg(100), 5);

    // Deleting needs the trainee's confirmation.
    const refused = await client.callTool({ name: 'delete_last_set', arguments: {} });
    expect(refused.isError).toBe(true);
    const deleted = (await call(client, 'delete_last_set', { confirmed: true })) as State & {
      deleted: SetView;
    };
    expect(deleted.deleted.setNumber).toBe(2);
    expect(deleted.exercises[0]!.workingSetsDone).toBe(1);
    expect(deleted.nextSet).toMatchObject({
      setNumber: 2,
      exerciseName: 'Seated dumbbell overhead press',
    });

    const finished = (await call(client, 'finish_session', {
      notes: 'Short on time.',
    })) as unknown as {
      finishedAt: string | null;
      setsLogged: number;
    };
    expect(finished.finishedAt).not.toBeNull();
    expect(finished.setsLogged).toBe(1);
    const row = await db.session.findUnique({ where: { id: sessionId } });
    expect(row?.finishedAt).not.toBeNull();
    expect(row?.notes).toBe('Short on time.');

    // Nothing in progress any more; a finished session takes no new set.
    expect((await call(client, 'get_session_state')).session).toBeNull();
    await expect(call(client, 'log_set', { sessionId, weight: 40, reps: 6 })).rejects.toThrow(
      /already finished|Every exercise is complete/,
    );
  });

  it('keeps sessions private to their owner and refuses writes on a read-only token', async () => {
    const owner = await seed('mcp-live-a@test.dev');
    const stranger = await seed('mcp-live-b@test.dev');
    const ownerClient = await connect(owner.user.id);
    const { session } = await call(ownerClient, 'start_session', { workoutId: owner.workout.id });

    const strangerClient = await connect(stranger.user.id);
    await expect(
      call(strangerClient, 'get_session_state', { sessionId: session!.id }),
    ).rejects.toThrow(/Session not found/);
    await expect(
      call(strangerClient, 'log_set', { sessionId: session!.id, weight: 40, reps: 6 }),
    ).rejects.toThrow(/Session not found/);
    // Another user's workout cannot be started either.
    await expect(
      call(strangerClient, 'start_session', { workoutId: owner.workout.id }),
    ).rejects.toThrow(/not found/);

    const readOnly = await connect(owner.user.id, false);
    expect((await call(readOnly, 'get_session_state')).session!.id).toBe(session!.id);
    await expect(call(readOnly, 'log_set', { weight: 40, reps: 6 })).rejects.toThrow(/read-only/);
    expect(await db.set.count({ where: { sessionId: session!.id } })).toBe(0);
  });

  it("announces gym loads in the trainee's unit as the app shows them", async () => {
    const { user, workout } = await seed('mcp-live-rounding@test.dev');
    // A 40 lb dumbbell saved through the gym form is stored as 18.14 kg.
    const gym = await db.gym.create({
      data: { userId: user.id, name: 'Home', dumbbellWeights: [13.61, 18.14, 22.68] },
    });
    await db.user.update({ where: { id: user.id }, data: { activeGymId: gym.id } });
    const client = await connect(user.id);
    await call(client, 'start_session', { workoutId: workout.id });

    const state = await call(client, 'log_set', { weight: 40, reps: 8, rir: 2 });
    expect(state.nextSet!.weightKg).toBeCloseTo(18.14, 2);
    expect(state.nextSet!.weight).toBe(40);
  });

  it("reports each exercise's previous session in the trainee's unit", async () => {
    const { user, workout } = await seed('mcp-live-last-time@test.dev');
    const client = await connect(user.id);

    const first = await call(client, 'start_session', { workoutId: workout.id });
    expect(first.exercises[0]!.lastTime).toBeNull();
    await call(client, 'log_set', { weight: 40, reps: 10, rir: 2 });
    await call(client, 'log_set', { weight: 40, reps: 9, rir: 1 });
    await call(client, 'finish_session', {});

    const second = await call(client, 'start_session', { workoutId: workout.id });
    expect(second.created).toBe(true);
    expect(second.exercises[0]!.lastTime).toMatchObject({
      sessionStartedAt: first.session!.startedAt,
      sets: [
        { weight: 40, reps: 10, rir: 2 },
        { weight: 40, reps: 9, rir: 1 },
      ],
    });
    // The curl was not done last time.
    expect(second.exercises[1]!.lastTime).toBeNull();
  });

  it('refuses a strength set without weight and reps instead of inventing them', async () => {
    const { user, workout } = await seed('mcp-live-partial@test.dev');
    const client = await connect(user.id);
    await call(client, 'start_session', { workoutId: workout.id });
    await expect(call(client, 'log_set', { reps: 6 })).rejects.toThrow(/needs weight and reps/);
  });
});
