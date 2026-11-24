import { z } from 'zod';

export const sessionStartSchema = z.object({
  // Absent (or null) starts a freestyle session (issue #388): no workout, no
  // program, exercises added from the catalog while training.
  workoutId: z.string().min(1).optional().nullable(),
  gymId: z.string().min(1).optional().nullable(),
});

export const sessionUpdateSchema = z.object({
  notes: z.string().trim().max(2000).optional().nullable(),
  // If true, finishes the session: finishedAt is now, or the time of the last
  // set when that set is more than 30 minutes old (lib/session-finish.ts).
  finish: z.boolean().optional(),
});

// One exercise of a freestyle session (issue #388): the targets the live
// runner needs, with the same bounds as a program exercise.
const sessionExerciseFields = z.object({
  exerciseId: z.string().min(1),
  targetSets: z.coerce.number().int().min(1).max(20),
  targetRepsMin: z.coerce.number().int().min(1).max(50),
  targetRepsMax: z.coerce.number().int().min(1).max(50),
  targetRIR: z.coerce.number().int().min(0).max(5),
  restSec: z.coerce.number().int().min(15).max(600),
});
const repsInOrder = {
  message: 'Reps max must be >= reps min',
  path: ['targetRepsMax'],
};

export const sessionExerciseInputSchema = sessionExerciseFields.refine(
  (v) => v.targetRepsMax >= v.targetRepsMin,
  repsInOrder,
);

// Where a change to a session's exercise list lands (lib/session-plan.ts):
// "today" changes this session's own copy only, "program" also changes the
// workout it runs. A freestyle session has no workout, so both mean today.
export const planScopeSchema = z.enum(['today', 'program']);

// Body of POST and PUT /api/sessions/[id]/exercises[/rowId]: the exercise and
// its targets, and the scope of the change (today when absent).
export const sessionExerciseChangeSchema = sessionExerciseFields
  .extend({ scope: planScopeSchema.default('today') })
  .refine((v) => v.targetRepsMax >= v.targetRepsMin, repsInOrder);

// Query of DELETE /api/sessions/[id]/exercises/[rowId].
export const sessionExerciseDeleteQuerySchema = z.object({
  scope: planScopeSchema.default('today'),
});

// Body of PATCH /api/sessions/[id]/exercises/[rowId]: skip the exercise for
// this session, or take the skip back.
export const sessionExerciseSkipSchema = z.object({ skipped: z.boolean() });

// Query of DELETE /api/sessions/[id]. `discardEmpty=1` is the "discard this
// empty session" action of the live runner (issue #388): the server then
// refuses a session that holds sets, whatever the client believed.
export const sessionDeleteQuerySchema = z.object({
  discardEmpty: z.literal('1').optional(),
});

export type SessionExerciseInput = z.infer<typeof sessionExerciseInputSchema>;
export type PlanScopeInput = z.infer<typeof planScopeSchema>;
export type SessionStart = z.infer<typeof sessionStartSchema>;
export type SessionUpdate = z.infer<typeof sessionUpdateSchema>;
