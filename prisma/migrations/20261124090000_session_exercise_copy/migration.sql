-- Today's copy of a workout (lib/session-plan.ts). Additive: SessionExercise
-- gains the program fields it needs to hold a copy of a workout's rows, a link
-- to the row it was copied from and a skipped marker. Existing freestyle rows
-- take NULL or the column default, which is what they meant before.

-- AlterTable
ALTER TABLE "SessionExercise" ADD COLUMN "programExerciseId" TEXT,
ADD COLUMN "tempo" TEXT,
ADD COLUMN "notes" TEXT,
ADD COLUMN "supersetGroup" INTEGER,
ADD COLUMN "autoregulationMode" "SetAutoregulationMode" NOT NULL DEFAULT 'PRESERVE_RIR',
ADD COLUMN "fatigueRate" DOUBLE PRECISION,
ADD COLUMN "loadAdjustmentPct" DOUBLE PRECISION,
ADD COLUMN "targetDurationSec" INTEGER,
ADD COLUMN "targetDistanceM" DOUBLE PRECISION,
ADD COLUMN "skippedAt" TIMESTAMP(3);

-- A copied workout can hold a deliberately repeated exercise (issue #429), so
-- the one-row-per-exercise rule moves from the index to the routes.
DROP INDEX "SessionExercise_sessionId_exerciseId_key";

-- CreateIndex
CREATE INDEX "SessionExercise_sessionId_exerciseId_idx" ON "SessionExercise"("sessionId", "exerciseId");

-- CreateIndex
CREATE INDEX "SessionExercise_programExerciseId_idx" ON "SessionExercise"("programExerciseId");

-- AddForeignKey
ALTER TABLE "SessionExercise" ADD CONSTRAINT "SessionExercise_programExerciseId_fkey" FOREIGN KEY ("programExerciseId") REFERENCES "ProgramExercise"("id") ON DELETE SET NULL ON UPDATE CASCADE;
