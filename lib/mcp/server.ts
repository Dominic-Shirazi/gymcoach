import { Buffer } from 'node:buffer';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { db } from '@/lib/db';
import { buildCoachPayload } from '@/lib/coach';
import {
  GYM_EQUIPMENT_IMAGE_MIME_TYPES,
  findOwnedGymEquipmentUpsertTarget,
  getOwnedGymEquipmentImage,
  getOwnedGymInventory,
  gymEquipmentImageRef,
  listOwnedGyms,
  setOwnedGymEquipmentImage,
  updateOwnedGymFreeWeights,
  upsertOwnedGymEquipment,
} from '@/lib/gym-equipment';
import { addWorkoutToProgram, buildProgramFromGenerated } from '@/lib/program-generation';
import {
  generatedExerciseSchema,
  generatedProgramSchema,
  generatedWorkoutSchema,
} from '@/lib/schemas/program-generation';
import { programInputSchema } from '@/lib/schemas/program';
import { gymWeightListSchema } from '@/lib/schemas/gym';
import { databaseIdSchema } from '@/lib/schemas/gym-equipment';
import { bodyweightKgSchema } from '@/lib/schemas/bodyweight';
import {
  EquipmentType,
  ExerciseCategory,
  MuscleGroup,
  SetAutoregulationMode,
} from '@/lib/prisma-client';
import type { McpPrincipal } from '@/lib/mcp/auth';
import {
  applyHistoricalEquipmentBackfill,
  HISTORICAL_EQUIPMENT_BACKFILL_AUDIT_LIST_LIMIT,
  HISTORICAL_EQUIPMENT_BACKFILL_MAX_SETS,
  listHistoricalEquipmentBackfills,
  parseHistoricalDateBound,
  previewHistoricalEquipmentBackfill,
  undoHistoricalEquipmentBackfill,
} from '@/lib/mcp/historical-equipment-backfill';
import { guardToolHandler } from '@/lib/mcp/errors';
import { consumeMcpWriteQuota, MCP_MAX_TOOL_INPUT_ELEMENTS } from '@/lib/mcp/limits';
import { updateUserProperties } from '@/lib/user-properties';
import type { WeightUnit } from '@/lib/prisma-client';
import {
  deleteOwnedSet,
  logOwnedSet,
  startOwnedSession,
  updateOwnedSession,
  updateOwnedSet,
} from '@/lib/live-session';
import { getOwnedSessionState, type LiveSessionState } from '@/lib/live-session-state';
import { setInputSchema, setUpdateSchema } from '@/lib/schemas/set';
import { getExerciseHistory, HISTORY_MAX_SESSIONS } from '@/lib/exercise-history';
import { findSubstitutes, SUBSTITUTES_MAX } from '@/lib/exercise-substitutes';
import { resolveCalendarTimeZone } from '@/lib/history-calendar';
import { listWorkouts } from '@/lib/workout-list';
import {
  addSessionExercise,
  removeSessionExercise,
  skipSessionExercise,
  swapSessionExercise,
} from '@/lib/session-plan';
import { aiParseSetWithFailure } from '@/lib/set-parse';
import { describeLlmFailure } from '@/lib/llm/errors';
import { getLlmProvider } from '@/lib/llm';
import { rateLimit } from '@/lib/rate-limit';
import { fromDisplayWeight } from '@/lib/units';

export const GYMCOACH_MCP_INSTRUCTIONS = `GymCoach stores the trainee's profile, gyms, equipment, programs, workout history, sets, RIR, goals and recovery signals.

Use read tools before making recommendations. Ground every recommendation in returned GymCoach data and never invent completed sets, available equipment, records or injuries. Respect the active gym's equipment constraints. Use the trainee's language.

For MCP tool discovery, inspect the complete tool list once before guessing names. Do not repeatedly probe synonyms or issue many filtered discovery requests. If the client cannot expose the complete tool list, call get_mcp_capability_index once and use the exact tool names it returns. If a capability is still missing after that, report it as missing instead of continuing trial-and-error.

Before changing gym inventory, read the saved gym first, explain the proposed additions or corrections, and require explicit confirmation. Do not guess machine identity, exercise links or selectable weights from ambiguous information.

Write tools (programs, gym inventory, equipment history, profile properties, live sessions) change saved data. Explain the proposed change before calling a write tool. Update bodyweight only through update_user_properties: it appends a history entry and syncs the current value the rest of the app reads. Newly created programs are inactive so the trainee can review them. Activate a program only when the trainee explicitly asks. To add a session (for example a cardio day) to the program the trainee already follows, call add_workout on that program rather than creating a new program. Never delete, remove or undo saved data (a program exercise, an equipment image, a historical equipment backfill) without explicit confirmation.

During a workout, call get_session_state before speaking about the next set and announce its targets as returned. Log a set only after the trainee reported it: log_set for given numbers, log_set_from_text for their words (the text stays as the set note). Fix a misheard set with edit_last_set; delete_last_set and finish_session only on the trainee's request.`;

interface ServerOptions {
  principal: McpPrincipal;
  baseUrl: string;
}

const explicitConfirmation = z
  .literal(true)
  .describe('Set to true only after the trainee explicitly confirmed this saved-data change.');

// Same opaque id shape the REST routes accept (legacy ids are not cuids).
const gymIdSchema = databaseIdSchema.describe('Opaque GymCoach gym ID returned by list_gyms.');
const equipmentIdSchema = databaseIdSchema.describe(
  'Opaque GymCoach equipment ID returned by get_gym_inventory.',
);

// Strict ISO 8601 calendar date (2026-08-31) or datetime with an offset
// (2026-08-31T18:00:00Z). Anything else - null, a number, free text - is
// rejected instead of being coerced into a surprising date.
const isoDateOrDatetime = z.union([z.string().date(), z.string().datetime({ offset: true })]);

function result(data: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function requireWrite(principal: McpPrincipal) {
  if (!principal.canWrite) {
    throw new Error(
      'This GymCoach MCP token is read-only. Create a write-enabled token in Settings.',
    );
  }
  // Every write tool calls this once, so the per-token write limit covers them
  // all (issue #376).
  consumeMcpWriteQuota(principal.tokenId);
}

async function getOwnedProgram(userId: string, programId?: string) {
  const program = programId
    ? await db.program.findFirst({ where: { id: programId, userId }, select: { id: true } })
    : await db.program.findFirst({ where: { userId, isActive: true }, select: { id: true } });
  if (!program) throw new Error(programId ? 'Program not found.' : 'No active program.');
  return program.id;
}

// Task-oriented index of every registered tool, and the single source of the
// tool list: GYMCOACH_MCP_TOOL_NAMES is flattened from these groups, and the
// unit test pins it to what the server registers. A tool added without an
// index entry (or an entry without a tool) fails the gate instead of leaving a
// client with a stale index.
const MCP_CAPABILITY_GROUPS = {
  discovery: {
    tools: ['get_mcp_capability_index'],
    note: 'Prefer one complete tools/list. Use this fallback once when the client cannot expose it.',
  },
  trainingContext: {
    tools: ['get_training_context'],
  },
  exerciseCatalog: {
    tools: ['list_exercises'],
  },
  profile: {
    write: ['update_user_properties'],
  },
  gyms: {
    read: ['list_gyms', 'get_gym_inventory', 'get_gym_equipment_image'],
    write: ['update_gym_free_weights', 'upsert_gym_equipment', 'set_gym_equipment_image'],
  },
  equipmentHistory: {
    read: ['preview_historical_equipment_backfill', 'list_historical_equipment_backfills'],
    write: ['apply_historical_equipment_backfill', 'undo_historical_equipment_backfill'],
  },
  programs: {
    read: ['list_programs', 'get_program'],
    write: [
      'create_program',
      'update_program_metadata',
      'add_workout',
      'add_program_exercise',
      'update_program_exercise',
      'remove_program_exercise',
      'activate_program',
    ],
  },
  liveSession: {
    read: ['list_workouts', 'get_session_state', 'get_exercise_history', 'find_substitutes'],
    write: [
      'start_session',
      'log_set',
      'log_set_from_text',
      'edit_last_set',
      'delete_last_set',
      'swap_exercise',
      'skip_exercise',
      'add_session_exercise',
      'remove_session_exercise',
      'finish_session',
    ],
  },
} as const;

export const GYMCOACH_MCP_TOOL_NAMES = Object.values(MCP_CAPABILITY_GROUPS).flatMap((group) =>
  'tools' in group ? [...group.tools] : [...('read' in group ? group.read : []), ...group.write],
);

const MCP_CAPABILITY_INDEX = {
  allTools: GYMCOACH_MCP_TOOL_NAMES,
  ...MCP_CAPABILITY_GROUPS,
};

export function createGymCoachMcpServer({ principal, baseUrl }: ServerOptions): McpServer {
  const server = new McpServer(
    {
      name: 'GymCoach',
      version: '1.0.0',
      websiteUrl: baseUrl,
    },
    { instructions: GYMCOACH_MCP_INSTRUCTIONS, maxToolInputElements: MCP_MAX_TOOL_INPUT_ELEMENTS },
  );

  server.registerResource(
    'gymcoach-agent-instructions',
    'gymcoach://instructions/agent',
    {
      title: 'GymCoach agent instructions',
      description: 'Rules for safely analysing and editing the trainee training data.',
      mimeType: 'text/plain',
    },
    async () => ({
      contents: [
        {
          uri: 'gymcoach://instructions/agent',
          mimeType: 'text/plain',
          text: GYMCOACH_MCP_INSTRUCTIONS,
        },
      ],
    }),
  );

  server.registerPrompt(
    'build-training-program',
    {
      title: 'Build a GymCoach training program',
      description: 'Analyse the trainee context and prepare a structured program for GymCoach.',
      argsSchema: { goal: z.string().trim().min(5).max(2000) },
    },
    async ({ goal }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Goal: ${goal}\n\nFirst call get_training_context and list_exercises. Design a realistic program that respects the saved gym and equipment. Explain the draft, ask for confirmation, then call create_program.`,
          },
        },
      ],
    }),
  );

  server.registerTool(
    'get_mcp_capability_index',
    {
      title: 'Get GymCoach MCP capability index',
      description:
        'Returns a compact task-oriented index of exact GymCoach MCP tool names. Use this once when the client cannot expose a complete tools/list; do not repeatedly guess tool names or probe synonyms.',
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    guardToolHandler(async () =>
      result({
        discoveryRule:
          'Prefer one complete tools/list. If unavailable, call get_mcp_capability_index once, then use exact names. Stop repeated synonym probing.',
        // Same flag requireWrite checks: the index is served to read-only
        // connections too, and they must not plan around tools they cannot call.
        writeAccess: principal.canWrite,
        writeAccessNote: principal.canWrite
          ? 'This connection can call the tools listed under "write". Each one still requires confirmed: true after the trainee agreed to the change.'
          : 'This connection is read-only: every tool listed under "write" is refused. Do not plan around them; tell the trainee a write-enabled connection from Settings is needed for changes.',
        capabilities: MCP_CAPABILITY_INDEX,
      }),
    ),
  );

  server.registerTool(
    'list_gyms',
    {
      title: 'List gyms',
      description:
        'Lists saved gyms, identifies the active gym and reports physical-equipment/config counts.',
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    guardToolHandler(async () => result(await listOwnedGyms(principal.userId))),
  );

  server.registerTool(
    'get_gym_inventory',
    {
      title: 'Get complete gym inventory',
      description:
        'Returns shared dumbbells, plates and bars and every saved physical equipment item with descriptions/images/exercise links. Omit gymId to read the active gym. Set includeExerciseCoverage to true to also get availability and weight options for every exercise of the trainee (a large payload; request it only when needed).',
      inputSchema: {
        gymId: gymIdSchema.optional(),
        includeExerciseCoverage: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    guardToolHandler(async ({ gymId, includeExerciseCoverage }) =>
      result(
        await getOwnedGymInventory(principal.userId, baseUrl, gymId, { includeExerciseCoverage }),
      ),
    ),
  );

  server.registerTool(
    'get_gym_equipment_image',
    {
      title: 'Get a gym-equipment image',
      description:
        'Returns a saved uploaded equipment image as MCP image content, or the external HTTPS image URL the trainee saved in GymCoach. Use this when visual comparison is needed.',
      inputSchema: {
        equipmentId: equipmentIdSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    guardToolHandler(async ({ equipmentId }) => {
      const saved = await getOwnedGymEquipmentImage(principal.userId, equipmentId);
      if (saved.kind === 'uploaded') {
        const metadata = {
          equipmentId,
          image: {
            kind: saved.kind,
            mimeType: saved.mimeType,
            updatedAt: saved.updatedAt,
          },
        };
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(metadata, null, 2) },
            {
              type: 'image' as const,
              data: Buffer.from(saved.bytes).toString('base64'),
              mimeType: saved.mimeType,
            },
          ],
          structuredContent: metadata,
        };
      }
      return result({ equipmentId, image: saved });
    }),
  );

  server.registerTool(
    'update_gym_free_weights',
    {
      title: 'Update gym free-weight inventory',
      description:
        'Replaces any supplied dumbbell, plate or bar lists in kg after the trainee confirms the inventory change. Omitted lists remain unchanged. The result includes the previous lists.',
      inputSchema: {
        confirmed: explicitConfirmation,
        gymId: gymIdSchema.optional(),
        dumbbellWeights: gymWeightListSchema.optional(),
        plateWeights: gymWeightListSchema.optional(),
        barWeights: gymWeightListSchema.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guardToolHandler(async ({ gymId, confirmed: _confirmed, ...patch }) => {
      requireWrite(principal);
      const { gym, previous } = await updateOwnedGymFreeWeights(principal.userId, gymId, patch);
      return result({ ok: true, gym, previous });
    }),
  );

  server.registerTool(
    'upsert_gym_equipment',
    {
      title: 'Add or update physical gym equipment',
      description:
        'Creates or updates a physical machine, station or accessory in a gym. Link exercise IDs to make those exercises available and apply machine/cable weight options. Without equipmentId, an item with the same name in the gym is overwritten; supplied fields and exercise links replace the saved ones. The result includes the previous values of the equipment item and its exercise links only, not the per-exercise gym configuration (availability and weight options) that the upsert also rewrites.',
      inputSchema: {
        confirmed: explicitConfirmation,
        gymId: gymIdSchema,
        equipmentId: equipmentIdSchema.optional(),
        name: z.string().trim().min(1).max(120),
        equipmentType: z.nativeEnum(EquipmentType),
        description: z.string().trim().max(4000).nullable().optional(),
        manufacturer: z.string().trim().max(120).nullable().optional(),
        modelName: z.string().trim().max(120).nullable().optional(),
        quantity: z.number().int().min(1).max(100).optional(),
        weightOptions: gymWeightListSchema.optional(),
        exerciseIds: z.array(databaseIdSchema).max(100).optional(),
        markExercisesAvailable: z.boolean().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guardToolHandler(async ({ gymId, confirmed: _confirmed, ...input }) => {
      requireWrite(principal);
      const previous = await findOwnedGymEquipmentUpsertTarget(principal.userId, gymId, input);
      const saved = await upsertOwnedGymEquipment(principal.userId, gymId, input);
      return result({ ok: true, ...saved, previous });
    }),
  );

  server.registerTool(
    'set_gym_equipment_image',
    {
      title: 'Set a gym-equipment image',
      description:
        'Sets or clears a physical equipment image after confirmation. Use exactly one of: clear, or JPEG/PNG/WebP base64 (raw with mimeType, or a data URL) stored in the GymCoach database. External image URLs are not accepted through MCP.',
      inputSchema: {
        confirmed: explicitConfirmation,
        equipmentId: equipmentIdSchema,
        clear: z.literal(true).optional(),
        imageBase64: z.string().min(1).max(7_100_000).optional(),
        mimeType: z.enum(GYM_EQUIPMENT_IMAGE_MIME_TYPES).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guardToolHandler(async ({ equipmentId, clear, imageBase64, mimeType }) => {
      requireWrite(principal);
      // Uploaded bytes or clear only: an external URL written by an agent would be
      // handed back to every later MCP client, so that mode stays web-UI only.
      if ((clear === true) === (imageBase64 != null)) {
        throw new Error('Choose exactly one image action: clear or imageBase64.');
      }
      // Named fields, not the parsed input spread: the lib helper still accepts
      // imageUrl for the web UI, and a field added to this schema later must not
      // reach it by accident.
      const equipment = await setOwnedGymEquipmentImage(principal.userId, equipmentId, {
        clear,
        imageBase64,
        mimeType,
      });
      const image = gymEquipmentImageRef(equipment);
      return result({ ok: true, equipment: { ...equipment, image } });
    }),
  );

  server.registerTool(
    'get_training_context',
    {
      title: 'Get training context',
      description:
        'Returns the trainee profile, recent training, active program, records, goals, fatigue, readiness, conditioning and active gym equipment.',
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    guardToolHandler(async () => {
      const [coach, user] = await Promise.all([
        buildCoachPayload(principal.userId),
        db.user.findUnique({
          where: { id: principal.userId },
          select: {
            unit: true,
            activeGym: {
              include: {
                exerciseConfigs: {
                  orderBy: { exercise: { name: 'asc' } },
                  include: {
                    exercise: {
                      select: { id: true, name: true, equipmentType: true },
                    },
                  },
                },
              },
            },
          },
        }),
      ]);
      return result({
        instructionsVersion: 1,
        unit: user?.unit ?? 'KG',
        activeGym: user?.activeGym ?? null,
        coach,
      });
    }),
  );

  server.registerTool(
    'update_user_properties',
    {
      title: 'Update user properties',
      description:
        'Updates user-specific saved properties after the trainee confirms the change. Only currentWeightKg (bodyweight in kg) is supported: it appends a bodyweight history entry and syncs the profile value the rest of the app reads. The result includes the previous profile value (previousWeightKg, null when it was never set).',
      inputSchema: {
        confirmed: explicitConfirmation,
        currentWeightKg: bodyweightKgSchema
          .optional()
          .describe('Current bodyweight in kg. At least one supported property must be supplied.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guardToolHandler(async ({ currentWeightKg }) => {
      requireWrite(principal);
      const updated = await updateUserProperties(principal.userId, { currentWeightKg });
      return result({ ok: true, ...updated });
    }),
  );

  server.registerTool(
    'list_exercises',
    {
      title: 'List exercise catalog',
      description: 'Lists the trainee exercise catalog with stable IDs and equipment categories.',
      inputSchema: {
        search: z.string().trim().max(120).optional(),
        limit: z.number().int().min(1).max(500).default(200),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    guardToolHandler(async ({ search, limit }) => {
      const exercises = await db.exercise.findMany({
        where: {
          userId: principal.userId,
          ...(search ? { name: { contains: search, mode: 'insensitive' as const } } : {}),
        },
        orderBy: { name: 'asc' },
        take: limit,
        select: {
          id: true,
          name: true,
          muscleGroup: true,
          category: true,
          equipmentType: true,
          usesBodyweight: true,
          defaultRestSec: true,
          notes: true,
        },
      });
      return result({ exercises });
    }),
  );

  server.registerTool(
    'preview_historical_equipment_backfill',
    {
      title: 'Preview historical equipment backfill',
      description:
        'Finds owned historical sets (finished sessions only) that are missing a physical equipment assignment and returns linked equipment candidates plus prior-use evidence. This tool never writes data and suggestions are not user confirmation.',
      inputSchema: {
        gymId: gymIdSchema.optional(),
        exerciseId: databaseIdSchema.optional(),
        from: isoDateOrDatetime
          .optional()
          .describe('ISO date or datetime; only sessions started at or after it.'),
        to: isoDateOrDatetime
          .optional()
          .describe('ISO date or datetime; a date-only value includes that whole UTC day.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(HISTORICAL_EQUIPMENT_BACKFILL_MAX_SETS)
          .default(HISTORICAL_EQUIPMENT_BACKFILL_MAX_SETS),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    guardToolHandler(async ({ from, to, ...input }) => {
      const preview = await previewHistoricalEquipmentBackfill(principal.userId, {
        ...input,
        from: from ? parseHistoricalDateBound(from, 'from') : undefined,
        to: to ? parseHistoricalDateBound(to, 'to') : undefined,
      });
      return result(preview);
    }),
  );

  server.registerTool(
    'list_historical_equipment_backfills',
    {
      title: 'List historical equipment backfills',
      description:
        'Lists the most recent audited historical equipment backfills of the trainee, newest first, with their audit IDs, undo state and set counts. Use it to find the audit ID of an earlier backfill before undoing it. This tool never writes data.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(HISTORICAL_EQUIPMENT_BACKFILL_AUDIT_LIST_LIMIT)
          .default(HISTORICAL_EQUIPMENT_BACKFILL_AUDIT_LIST_LIMIT),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    guardToolHandler(async ({ limit }) =>
      result(await listHistoricalEquipmentBackfills(principal.userId, limit)),
    ),
  );

  server.registerTool(
    'apply_historical_equipment_backfill',
    {
      title: 'Apply historical equipment backfill',
      description:
        'Assigns one explicitly confirmed owned gym/exercise/equipment mapping to an exact list of historical sets (finished sessions only) that are still unassigned. Returns an audit ID for safe undo; the ID stays recoverable later through list_historical_equipment_backfills.',
      inputSchema: {
        confirmed: explicitConfirmation,
        gymId: gymIdSchema,
        exerciseId: databaseIdSchema,
        equipmentId: databaseIdSchema,
        setIds: z.array(z.string().cuid()).min(1).max(HISTORICAL_EQUIPMENT_BACKFILL_MAX_SETS),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guardToolHandler(async (input) => {
      requireWrite(principal);
      const applied = await applyHistoricalEquipmentBackfill(principal.userId, input);
      return result(applied);
    }),
  );

  server.registerTool(
    'undo_historical_equipment_backfill',
    {
      title: 'Undo historical equipment backfill',
      description:
        'Atomically undoes one audited historical equipment backfill only when every affected set still exactly matches the recorded applied equipment snapshot.',
      inputSchema: {
        confirmed: explicitConfirmation,
        auditId: z.string().cuid(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guardToolHandler(async (input) => {
      requireWrite(principal);
      const undone = await undoHistoricalEquipmentBackfill(principal.userId, input);
      return result(undone);
    }),
  );

  server.registerTool(
    'list_programs',
    {
      title: 'List training programs',
      description: 'Lists saved programs and their workout counts.',
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    guardToolHandler(async () => {
      const programs = await db.program.findMany({
        where: { userId: principal.userId },
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          name: true,
          phase: true,
          description: true,
          isActive: true,
          updatedAt: true,
          _count: { select: { workouts: true, sessions: true } },
        },
      });
      return result({ programs });
    }),
  );

  server.registerTool(
    'get_program',
    {
      title: 'Get a training program',
      description: 'Returns a complete program with workout, exercise and autoregulation IDs.',
      inputSchema: {
        programId: z.string().cuid().optional().describe('Omit to read the active program.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    guardToolHandler(async ({ programId }) => {
      const id = await getOwnedProgram(principal.userId, programId);
      const program = await db.program.findUnique({
        where: { id },
        include: {
          workouts: {
            orderBy: { order: 'asc' },
            include: {
              exercises: {
                orderBy: { order: 'asc' },
                include: { exercise: true },
              },
            },
          },
        },
      });
      return result({ program });
    }),
  );

  server.registerTool(
    'create_program',
    {
      title: 'Create training program',
      description:
        'Creates a complete inactive GymCoach program. Explain the draft and obtain user confirmation before calling.',
      inputSchema: { confirmed: explicitConfirmation, program: generatedProgramSchema },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guardToolHandler(async ({ program }) => {
      requireWrite(principal);
      const id = await buildProgramFromGenerated(principal.userId, program);
      return result({ ok: true, programId: id, active: false });
    }),
  );

  server.registerTool(
    'update_program_metadata',
    {
      title: 'Update program details',
      description: 'Updates a program name, phase and description after user confirmation.',
      inputSchema: {
        confirmed: explicitConfirmation,
        programId: z.string().cuid(),
        values: programInputSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guardToolHandler(async ({ programId, values }) => {
      requireWrite(principal);
      await getOwnedProgram(principal.userId, programId);
      const program = await db.program.update({
        where: { id: programId },
        data: {
          name: values.name,
          phase: values.phase,
          description: values.description ?? null,
        },
      });
      return result({ ok: true, program });
    }),
  );

  server.registerTool(
    'add_workout',
    {
      title: 'Add workout to program',
      description:
        'Appends a workout (a training session with its exercises, cardio included) to an existing program after user confirmation. Omit programId to target the active program.',
      inputSchema: {
        confirmed: explicitConfirmation,
        programId: z.string().cuid().optional().describe('Omit to add to the active program.'),
        workout: generatedWorkoutSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guardToolHandler(async ({ programId, workout: input }) => {
      requireWrite(principal);
      const id = await getOwnedProgram(principal.userId, programId);
      const workoutId = await addWorkoutToProgram(principal.userId, id, input);
      const workout = await db.workout.findUnique({
        where: { id: workoutId },
        include: { exercises: { orderBy: { order: 'asc' }, include: { exercise: true } } },
      });
      return result({ ok: true, programId: id, workout });
    }),
  );

  server.registerTool(
    'add_program_exercise',
    {
      title: 'Add program exercise',
      description: 'Adds an exercise to an existing workout after user confirmation.',
      inputSchema: {
        confirmed: explicitConfirmation,
        workoutId: z.string().cuid(),
        exercise: generatedExerciseSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guardToolHandler(async ({ workoutId, exercise: input }) => {
      requireWrite(principal);
      const workout = await db.workout.findFirst({
        where: { id: workoutId, program: { userId: principal.userId } },
        select: { id: true },
      });
      if (!workout) throw new Error('Workout not found.');

      const created = await db.$transaction(async (tx) => {
        const exercise = await tx.exercise.upsert({
          where: { userId_name: { userId: principal.userId, name: input.name } },
          update: {},
          create: {
            userId: principal.userId,
            name: input.name,
            muscleGroup: input.muscleGroup,
            category: input.category,
            equipmentType: input.equipmentType ?? 'OTHER',
            defaultRestSec: input.restSec,
          },
        });
        // Same rule as the REST routes (issues #379, #426): one row per
        // exercise in a workout, because the live runner shares one set pool
        // per exercise.
        const duplicate = await tx.programExercise.findFirst({
          where: { workoutId, exerciseId: exercise.id },
          select: { id: true },
        });
        if (duplicate) throw new Error('That exercise is already in this workout.');
        const last = await tx.programExercise.findFirst({
          where: { workoutId },
          orderBy: { order: 'desc' },
          select: { order: true },
        });
        return tx.programExercise.create({
          data: {
            workoutId,
            exerciseId: exercise.id,
            order: (last?.order ?? 0) + 1,
            targetSets: input.targetSets,
            targetRepsMin: input.targetRepsMin,
            targetRepsMax: input.targetRepsMax,
            targetRIR: input.targetRIR,
            restSec: input.restSec,
            autoregulationMode: input.autoregulationMode ?? 'PRESERVE_RIR',
            fatigueRate: input.fatigueRate ?? null,
            loadAdjustmentPct: input.loadAdjustmentPct ?? null,
            supersetGroup: input.supersetGroup ?? null,
            tempo: input.tempo ?? null,
            notes: input.notes ?? null,
          },
          include: { exercise: true },
        });
      });
      return result({ ok: true, programExercise: created });
    }),
  );

  server.registerTool(
    'update_program_exercise',
    {
      title: 'Update program exercise',
      description:
        'Changes targets and autoregulation for an existing program exercise after user confirmation.',
      inputSchema: {
        programExerciseId: z.string().cuid(),
        confirmed: explicitConfirmation,
        targetSets: z.number().int().min(1).max(20).optional(),
        targetRepsMin: z.number().int().min(1).max(50).optional(),
        targetRepsMax: z.number().int().min(1).max(50).optional(),
        targetRIR: z.number().int().min(0).max(5).optional(),
        restSec: z.number().int().min(15).max(600).optional(),
        autoregulationMode: z.nativeEnum(SetAutoregulationMode).optional(),
        fatigueRate: z.number().min(0.25).max(2).nullable().optional(),
        loadAdjustmentPct: z.number().min(1).max(5).nullable().optional(),
        supersetGroup: z.number().int().min(1).max(9).nullable().optional(),
        tempo: z.string().trim().max(20).nullable().optional(),
        notes: z.string().trim().max(2000).nullable().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guardToolHandler(async ({ programExerciseId, confirmed: _confirmed, ...patch }) => {
      requireWrite(principal);
      const current = await db.programExercise.findFirst({
        where: { id: programExerciseId, workout: { program: { userId: principal.userId } } },
      });
      if (!current) throw new Error('Program exercise not found.');

      const min = patch.targetRepsMin ?? current.targetRepsMin;
      const max = patch.targetRepsMax ?? current.targetRepsMax;
      if (max < min)
        throw new Error('targetRepsMax must be greater than or equal to targetRepsMin.');

      const updated = await db.programExercise.update({
        where: { id: programExerciseId },
        data: patch,
        include: { exercise: true },
      });
      return result({ ok: true, programExercise: updated });
    }),
  );

  server.registerTool(
    'remove_program_exercise',
    {
      title: 'Remove program exercise',
      description: 'Removes one exercise from a program. Requires explicit user confirmation.',
      inputSchema: { confirmed: explicitConfirmation, programExerciseId: z.string().cuid() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guardToolHandler(async ({ programExerciseId }) => {
      requireWrite(principal);
      const current = await db.programExercise.findFirst({
        where: { id: programExerciseId, workout: { program: { userId: principal.userId } } },
        include: { exercise: { select: { name: true } } },
      });
      if (!current) throw new Error('Program exercise not found.');
      await db.programExercise.delete({ where: { id: programExerciseId } });
      return result({ ok: true, removedExercise: current.exercise.name });
    }),
  );

  server.registerTool(
    'activate_program',
    {
      title: 'Activate training program',
      description: 'Makes a saved program active. Call only after explicit user confirmation.',
      inputSchema: { confirmed: explicitConfirmation, programId: z.string().cuid() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guardToolHandler(async ({ programId }) => {
      requireWrite(principal);
      await getOwnedProgram(principal.userId, programId);
      await db.$transaction([
        db.program.updateMany({
          where: { userId: principal.userId, isActive: true, id: { not: programId } },
          data: { isActive: false },
        }),
        db.program.update({ where: { id: programId }, data: { isActive: true } }),
      ]);
      return result({ ok: true, programId, active: true });
    }),
  );

  // ------------------------------------------------------------------
  // Live session: what a voice coach drives during a workout. Writes go
  // through lib/live-session.ts, the same service as the REST routes, and
  // every tool answers with the fresh session state.
  // ------------------------------------------------------------------

  async function liveState(sessionId?: string) {
    const state = await getOwnedSessionState(principal.userId, sessionId);
    if (!state) throw new Error('No active session. Start one with start_session.');
    return state;
  }

  function liveRow(state: LiveSessionState, programExerciseId?: string) {
    const row = programExerciseId
      ? state.exercises.find((exercise) => exercise.programExerciseId === programExerciseId)
      : state.currentExerciseIndex != null
        ? state.exercises[state.currentExerciseIndex]
        : undefined;
    if (!row) {
      throw new Error(
        programExerciseId
          ? 'Exercise not found in this session.'
          : 'Every exercise is complete. Pass programExerciseId to log an extra set.',
      );
    }
    return row;
  }

  function lastSetOf(state: LiveSessionState) {
    if (!state.lastSet) throw new Error('No set logged in this session yet.');
    return state.lastSet;
  }

  async function liveUnit(): Promise<WeightUnit> {
    const user = await db.user.findUnique({
      where: { id: principal.userId },
      select: { unit: true },
    });
    return user?.unit ?? 'KG';
  }

  const sessionIdSchema = databaseIdSchema
    .describe('Opaque GymCoach session ID. Omit to use the unfinished session.')
    .optional();
  const programExerciseIdSchema = databaseIdSchema
    .describe(
      'Opaque row ID from get_session_state exercises[].programExerciseId. Omit for the current exercise.',
    )
    .optional();
  const liveWeight = z
    .number()
    .min(0)
    .max(1100)
    .describe("Load in the trainee's unit (get_session_state unit).");

  server.registerTool(
    'list_workouts',
    {
      title: 'List workouts to start',
      description:
        "The active program's workouts in order, each with its exercise count, an estimated length in minutes (sets x (45 s + rest), cardio by its duration) and when it was last done; the unfinished session, if any; and suggestedWorkoutId: the one in progress, else one scheduled for today's weekday (needs timeZone) not done yet today, else the one after the most recently done. Pass a workout ID to start_session.",
      inputSchema: {
        timeZone: z
          .string()
          .max(64)
          .optional()
          .describe("The trainee's IANA time zone (e.g. America/Los_Angeles), for today's weekday."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    guardToolHandler(async ({ timeZone }) => {
      const zone = timeZone ? resolveCalendarTimeZone(timeZone, '') || undefined : undefined;
      return result(await listWorkouts(principal.userId, { timeZone: zone }));
    }),
  );

  server.registerTool(
    'get_session_state',
    {
      title: 'Get live session state',
      description:
        "Reads the unfinished (or given) session: each exercise with targets, form cue, sets done and completion, the current exercise, the next set's targets (weight in kg and in the trainee's unit, reps, RIR, toFailure when targetRIR is 0), the last set and the rest countdown. Returns { session: null } when nothing is in progress.",
      inputSchema: { sessionId: sessionIdSchema },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guardToolHandler(async ({ sessionId }) => {
      const state = await getOwnedSessionState(principal.userId, sessionId);
      return result(state ? { ...state } : { session: null });
    }),
  );

  server.registerTool(
    'get_exercise_history',
    {
      title: 'Get one exercise history',
      description:
        "Recent sessions of one exercise (sets in the trainee's unit), its all-time heaviest set and best estimated 1RM, and the trend of the best estimated 1RM over those sessions (up, flat, down or not_enough_data, with the percent change and whether it is stalled). Find the exercise by exerciseId or by a name query; a query matching several exercises returns found: false with candidates to ask about. For \"is that a PR\" during a workout, read lastSet.prs from get_session_state instead.",
      inputSchema: {
        exerciseId: databaseIdSchema.describe('Opaque exercise ID from list_exercises or get_session_state.').optional(),
        query: z.string().trim().min(2).max(80).describe('Part of the exercise name, e.g. "bench" or "goblet squat".').optional(),
        sessions: z.number().int().min(1).max(HISTORY_MAX_SESSIONS).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guardToolHandler(async ({ exerciseId, query, sessions }) => {
      if (!exerciseId && !query) throw new Error('Give an exerciseId or a query.');
      return result(await getExerciseHistory(principal.userId, { exerciseId, query, sessions }));
    }),
  );

  server.registerTool(
    'start_session',
    {
      title: 'Start or resume a workout session',
      description:
        'Starts a session on a program workout (workout IDs from get_program) and returns its state. An unfinished session on the same workout is resumed instead of creating a second one. Without workoutId, returns the unfinished session when there is one.',
      inputSchema: {
        workoutId: databaseIdSchema.describe('Opaque workout ID from get_program.').optional(),
        gymId: gymIdSchema.optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guardToolHandler(async ({ workoutId, gymId }) => {
      requireWrite(principal);
      if (!workoutId) {
        const active = await getOwnedSessionState(principal.userId);
        if (!active) {
          throw new Error('No session in progress. Pass workoutId from get_program to start one.');
        }
        return result({ ok: true, created: false, ...active });
      }
      const { session, created } = await startOwnedSession(principal.userId, { workoutId, gymId });
      return result({ ok: true, created, ...(await liveState(session.id)) });
    }),
  );

  server.registerTool(
    'log_set',
    {
      title: 'Log a set',
      description:
        "Logs a completed set on the current exercise (or programExerciseId) as the trainee reported it, then returns the new state. Strength: weight (trainee's unit) and reps, optional rir. Cardio: durationSec, optional distanceM. Never invent values the trainee did not give.",
      inputSchema: {
        sessionId: sessionIdSchema,
        programExerciseId: programExerciseIdSchema,
        weight: liveWeight.optional(),
        reps: z.number().int().min(0).max(100).optional(),
        rir: z.number().int().min(0).max(5).nullable().optional(),
        durationSec: z.number().int().min(1).max(86_400).optional(),
        distanceM: z.number().min(0).max(1_000_000).optional(),
        isWarmup: z.boolean().optional(),
        isDropSet: z.boolean().optional(),
        notes: z.string().trim().max(500).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guardToolHandler(async ({ sessionId, programExerciseId, ...input }) => {
      requireWrite(principal);
      const state = await liveState(sessionId);
      const row = liveRow(state, programExerciseId);
      const isCardio = row.category === 'CARDIO';
      if (!isCardio && (input.weight == null || input.reps == null)) {
        throw new Error('A strength set needs weight and reps.');
      }
      const unit = await liveUnit();
      const data = setInputSchema.parse({
        exerciseId: row.exerciseId,
        setNumber: row.nextSetNumber,
        block: row.block,
        weight: isCardio ? 0 : fromDisplayWeight(input.weight!, unit),
        reps: isCardio ? 1 : input.reps,
        rir: isCardio ? null : (input.rir ?? null),
        durationSec: isCardio ? (input.durationSec ?? null) : null,
        distanceM: isCardio ? (input.distanceM ?? null) : null,
        isWarmup: input.isWarmup ?? false,
        isDropSet: input.isDropSet ?? false,
        notes: input.notes ?? null,
      });
      const set = await logOwnedSet(principal.userId, state.session.id, data);
      return result({ ok: true, loggedSetId: set.id, ...(await liveState(state.session.id)) });
    }),
  );

  server.registerTool(
    'log_set_from_text',
    {
      title: 'Log a set from what the trainee said',
      description:
        'Parses a spoken or typed set description ("six at 40, last one was a grind") with the same parser as the app, logs it on the current exercise (or programExerciseId) and returns the parsed values and the new state. The original text is kept as the set note, so remarks like pain or form stay on record. Fails without logging when the text cannot be read as a set.',
      inputSchema: {
        sessionId: sessionIdSchema,
        programExerciseId: programExerciseIdSchema,
        text: z.string().trim().min(1).max(500),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guardToolHandler(async ({ sessionId, programExerciseId, text }) => {
      requireWrite(principal);
      // Shares the REST parse route's budget: the call reaches the model.
      const rl = rateLimit(`set-parse:${principal.userId}`, 20, 60_000);
      if (!rl.ok) throw new Error('Too many parse requests. Please wait a moment.');
      const state = await liveState(sessionId);
      const row = liveRow(state, programExerciseId);
      const unit = await liveUnit();
      const { parsed, providerError } = await aiParseSetWithFailure(text, {
        exerciseName: row.name,
        kind: row.category === 'CARDIO' ? 'cardio' : 'strength',
        unit,
      });
      if (providerError) {
        throw new Error(describeLlmFailure(providerError, getLlmProvider()).message);
      }
      if (!parsed) {
        throw new Error('Could not read a set from that text. Nothing was logged.');
      }
      const data = setInputSchema.parse({
        exerciseId: row.exerciseId,
        setNumber: row.nextSetNumber,
        block: row.block,
        ...(parsed.kind === 'strength'
          ? {
              weight: fromDisplayWeight(parsed.weight, unit),
              reps: parsed.reps,
              rir: parsed.rir ?? null,
            }
          : {
              weight: 0,
              reps: 1,
              durationSec: parsed.durationSec,
              distanceM: parsed.distanceM ?? null,
              avgHr: parsed.avgHr ?? null,
            }),
        notes: text,
      });
      const set = await logOwnedSet(principal.userId, state.session.id, data);
      return result({
        ok: true,
        parsed,
        loggedSetId: set.id,
        ...(await liveState(state.session.id)),
      });
    }),
  );

  server.registerTool(
    'edit_last_set',
    {
      title: 'Correct the last logged set',
      description:
        "Corrects the weight (trainee's unit), reps, RIR or note of the session's most recent strength set. Omitted fields keep their logged value.",
      inputSchema: {
        sessionId: sessionIdSchema,
        weight: liveWeight.optional(),
        reps: z.number().int().min(0).max(100).optional(),
        rir: z.number().int().min(0).max(5).nullable().optional(),
        notes: z
          .string()
          .trim()
          .max(500)
          .nullable()
          .optional()
          .describe('Replaces the set note; omit to keep it, null to clear it.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guardToolHandler(async ({ sessionId, weight, reps, rir, notes }) => {
      requireWrite(principal);
      const state = await liveState(sessionId);
      const last = lastSetOf(state);
      const unit = await liveUnit();
      const data = setUpdateSchema.parse({
        weight: weight != null ? fromDisplayWeight(weight, unit) : last.weightKg,
        reps: reps ?? last.reps,
        rir: rir === undefined ? last.rir : rir,
        ...(notes !== undefined ? { notes } : {}),
      });
      await updateOwnedSet(principal.userId, last.setId, data);
      return result({ ok: true, editedSetId: last.setId, ...(await liveState(state.session.id)) });
    }),
  );

  server.registerTool(
    'delete_last_set',
    {
      title: 'Delete the last logged set',
      description:
        "Deletes the session's most recent set after the trainee confirmed it (for example a set logged by mistake). The result includes the deleted set.",
      inputSchema: { confirmed: explicitConfirmation, sessionId: sessionIdSchema },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guardToolHandler(async ({ sessionId }) => {
      requireWrite(principal);
      const state = await liveState(sessionId);
      const last = lastSetOf(state);
      if (state.session.finishedAt) throw new Error('Session already finished.');
      await deleteOwnedSet(principal.userId, last.setId);
      return result({ ok: true, deleted: last, ...(await liveState(state.session.id)) });
    }),
  );

  // Changes to today's list (lib/session-plan.ts). "today" runs a copy of the
  // workout for this session and leaves the saved program alone; "program"
  // edits the program too. The coach asks the trainee which one.
  const planScope = z
    .enum(['today', 'program'])
    .describe(
      'today: this session only, the saved program stays as it is. program: from now on, the saved program changes too. Ask the trainee ("just today, or from now on?") before choosing program.',
    );

  async function openLiveState(sessionId?: string) {
    const state = await liveState(sessionId);
    if (state.session.finishedAt) throw new Error('Session already finished.');
    return state;
  }

  server.registerTool(
    'find_substitutes',
    {
      title: 'Find substitutes for an exercise',
      description:
        "Exercises that can replace the current exercise (or programExerciseId) today: same primary muscle group, not already on today's list, and doable with the session gym's equipment. Best first: same category, favourites, most recently done. Pass one to swap_exercise.",
      inputSchema: {
        sessionId: sessionIdSchema,
        programExerciseId: programExerciseIdSchema,
        limit: z.number().int().min(1).max(SUBSTITUTES_MAX).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guardToolHandler(async ({ sessionId, programExerciseId, limit }) => {
      const state = await liveState(sessionId);
      const row = liveRow(state, programExerciseId);
      const session = await db.session.findFirst({
        where: { id: state.session.id, userId: principal.userId },
        select: { gymId: true },
      });
      const substitutes = await findSubstitutes(principal.userId, {
        sessionId: state.session.id,
        gymId: session?.gymId ?? null,
        exerciseId: row.exerciseId,
        onList: state.exercises.map((exercise) => exercise.exerciseId),
        limit,
      });
      return result({ for: { programExerciseId: row.programExerciseId, name: row.name }, substitutes });
    }),
  );

  server.registerTool(
    'swap_exercise',
    {
      title: 'Swap an exercise',
      description:
        "Replaces the current exercise (or programExerciseId) with exerciseId, keeping its targets when both are strength or both cardio. scope today changes only this session; program also changes the saved workout. Sets already logged stay in history. Returns the new state; row IDs change after the first today change, so read them from it.",
      inputSchema: {
        sessionId: sessionIdSchema,
        programExerciseId: programExerciseIdSchema,
        exerciseId: databaseIdSchema.describe('Opaque exercise ID, e.g. from find_substitutes.'),
        scope: planScope,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guardToolHandler(async ({ sessionId, programExerciseId, exerciseId, scope }) => {
      requireWrite(principal);
      const state = await openLiveState(sessionId);
      const row = liveRow(state, programExerciseId);
      const change = await swapSessionExercise(principal.userId, state.session.id, {
        rowId: row.programExerciseId,
        exerciseId,
        scope,
      });
      return result({ ok: true, ...change, ...(await liveState(state.session.id)) });
    }),
  );

  server.registerTool(
    'skip_exercise',
    {
      title: 'Skip an exercise for this session',
      description:
        'Skips the current exercise (or programExerciseId) for this session only: it leaves the plan, the next one becomes current, and the skip stays on record for the coach. skipped false takes a skip back (IDs in get_session_state skipped[]). The last exercise left cannot be skipped; finish the session instead.',
      inputSchema: {
        sessionId: sessionIdSchema,
        programExerciseId: programExerciseIdSchema,
        skipped: z.boolean().optional().describe('false takes a skip back. Default true.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    guardToolHandler(async ({ sessionId, programExerciseId, skipped }) => {
      requireWrite(principal);
      const state = await openLiveState(sessionId);
      const unskip = skipped === false;
      const rowId = unskip
        ? (programExerciseId ?? state.skipped.at(-1)?.programExerciseId)
        : liveRow(state, programExerciseId).programExerciseId;
      if (!rowId) throw new Error('Nothing is skipped in this session.');
      const change = await skipSessionExercise(principal.userId, state.session.id, {
        rowId,
        skipped: !unskip,
      });
      return result({ ok: true, ...change, ...(await liveState(state.session.id)) });
    }),
  );

  server.registerTool(
    'add_session_exercise',
    {
      title: 'Add an exercise to the session',
      description:
        "Adds exerciseId with default targets (4 x 8-12 at RIR 2, its own rest; one set for cardio), right after the current exercise when next is true, else at the end. scope today adds it to this session only; program also adds it to the end of the saved workout.",
      inputSchema: {
        sessionId: sessionIdSchema,
        exerciseId: databaseIdSchema.describe('Opaque exercise ID from list_exercises.'),
        next: z.boolean().optional().describe('Place it right after the current exercise.'),
        scope: planScope,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guardToolHandler(async ({ sessionId, exerciseId, next, scope }) => {
      requireWrite(principal);
      const state = await openLiveState(sessionId);
      const current =
        next && state.currentExerciseIndex != null
          ? state.exercises[state.currentExerciseIndex]?.programExerciseId
          : undefined;
      const change = await addSessionExercise(principal.userId, state.session.id, {
        exerciseId,
        scope,
        afterRowId: current,
      });
      return result({ ok: true, ...change, ...(await liveState(state.session.id)) });
    }),
  );

  server.registerTool(
    'remove_session_exercise',
    {
      title: 'Remove an exercise from the session',
      description:
        'Removes programExerciseId after the trainee confirmed it. scope today removes it from this session only (prefer skip_exercise, which keeps it on record); program also deletes it from the saved workout. Sets already logged stay in history. A workout keeps at least one exercise.',
      inputSchema: {
        confirmed: explicitConfirmation,
        sessionId: sessionIdSchema,
        programExerciseId: databaseIdSchema.describe(
          'Opaque row ID from get_session_state exercises[].programExerciseId.',
        ),
        scope: planScope,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    guardToolHandler(async ({ sessionId, programExerciseId, scope }) => {
      requireWrite(principal);
      const state = await openLiveState(sessionId);
      const row = liveRow(state, programExerciseId);
      const change = await removeSessionExercise(principal.userId, state.session.id, {
        rowId: row.programExerciseId,
        scope,
      });
      return result({ ok: true, ...change, ...(await liveState(state.session.id)) });
    }),
  );

  server.registerTool(
    'finish_session',
    {
      title: 'Finish the workout session',
      description:
        'Finishes the unfinished (or given) session, optionally saving session notes. A late finish is dated at the last set, as in the app.',
      inputSchema: {
        sessionId: sessionIdSchema,
        notes: z.string().trim().max(2000).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    guardToolHandler(async ({ sessionId, notes }) => {
      requireWrite(principal);
      const state = await liveState(sessionId);
      if (state.session.finishedAt) throw new Error('Session already finished.');
      const finished = await updateOwnedSession(principal.userId, state.session.id, {
        notes,
        finish: true,
      });
      return result({
        ok: true,
        sessionId: finished.id,
        finishedAt: finished.finishedAt?.toISOString() ?? null,
        setsLogged: state.exercises.reduce((sum, exercise) => sum + exercise.sets.length, 0),
      });
    }),
  );

  return server;
}

// Exported for schema documentation and future OAuth scopes.
export const MCP_ENUMS = {
  equipmentTypes: Object.values(EquipmentType),
  exerciseCategories: Object.values(ExerciseCategory),
  muscleGroups: Object.values(MuscleGroup),
};
