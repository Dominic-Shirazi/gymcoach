'use client';

import { useId, useMemo, useRef, useState } from 'react';
import { Plus, Replace, Search, Star, Trash2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { Exercise, ProgramExercise } from '@/lib/prisma-client';
import { favoritesFirst } from '@/lib/exercise-favorites';
import { matchesSearch } from '@/lib/search-fold';
import { addedExerciseTargets } from '@/lib/freestyle';
import { useExerciseName } from '@/components/shared/use-exercise-name';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

type SessionProgramExercise = ProgramExercise & { exercise: Exercise };
// The catalog fields this menu reads. The session page selects exactly these,
// so the rest of each exercise row (notes, owner id) stays on the server.
export type SessionCatalogExercise = Pick<
  Exercise,
  'id' | 'name' | 'muscleGroup' | 'category' | 'usesBodyweight' | 'defaultRestSec' | 'isFavorite'
>;
type View = 'actions' | 'replace' | 'add' | 'removeConfirm';
type Scope = 'today' | 'program';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  programExercise: SessionProgramExercise;
  programExercises: SessionProgramExercise[];
  catalog: SessionCatalogExercise[];
  loggedSetCount: number;
  // Every action goes to the session's own routes (lib/session-plan.ts). On a
  // session run from a workout each change asks "just today, or from now
  // on?": just today changes the session's copy of the workout, from now on
  // the saved program too. A freestyle session (issue #388) has no program,
  // so its changes apply at once to the session.
  sessionId: string;
  freestyle?: boolean;
  onChanged: (options?: { selectProgramExerciseId?: string; removedProgramExerciseId?: string }) => void;
}

// A swap sends targets only: the old row's when both exercises are of the
// same kind, the new exercise's defaults otherwise (strength targets make no
// sense for cardio and the other way round). The server resets the fatigue
// tuning of the old exercise and keeps the row's other settings.
function replacementPayload(
  programExercise: SessionProgramExercise,
  exercise: SessionCatalogExercise,
) {
  const sameKind =
    (programExercise.exercise.category === 'CARDIO') === (exercise.category === 'CARDIO');
  return sameKind
    ? {
        exerciseId: exercise.id,
        targetSets: programExercise.targetSets,
        targetRepsMin: programExercise.targetRepsMin,
        targetRepsMax: programExercise.targetRepsMax,
        targetRIR: programExercise.targetRIR,
        restSec: programExercise.restSec,
      }
    : addedExerciseTargets(exercise);
}

export function SessionExerciseMenu({
  open,
  onOpenChange,
  programExercise,
  programExercises,
  catalog,
  loggedSetCount,
  sessionId,
  freestyle = false,
  onChanged,
}: Props) {
  const t = useTranslations('session.exerciseMenu');
  const exerciseName = useExerciseName();
  const locale = useLocale();
  const [view, setView] = useState<View>('actions');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingReplacement, setPendingReplacement] = useState<SessionCatalogExercise | null>(null);
  const [pendingAddition, setPendingAddition] = useState<SessionCatalogExercise | null>(null);
  // `busy` disables the buttons on the next render; the ref closes the gap
  // for a second call that arrives before that render.
  const inFlight = useRef(false);

  const currentIndex = programExercises.findIndex((item) => item.id === programExercise.id);
  const previous = currentIndex > 0 ? programExercises[currentIndex - 1] : undefined;
  const next = currentIndex >= 0 ? programExercises[currentIndex + 1] : undefined;
  // Removing the only exercise would leave the runner on its empty state,
  // which has no Finish button. Replace stays available. A freestyle session
  // has an empty state of its own (pick an exercise), so nothing is blocked.
  const onlyExercise = !freestyle && programExercises.length <= 1;
  const rowsUrl = '/api/sessions/' + encodeURIComponent(sessionId) + '/exercises';
  const rowUrl = rowsUrl + '/' + encodeURIComponent(programExercise.id);
  // A freestyle session has no program, so it sends no scope.
  const scoped = <T extends object>(body: T, scope: Scope) => (freestyle ? body : { ...body, scope });
  const removeBlockedId = useId();
  const existingExerciseIds = useMemo(
    () => new Set(programExercises.map((item) => item.exerciseId)),
    [programExercises],
  );

  const choices = useMemo(() => {
    const needle = query.trim();
    const source =
      view === 'add'
        ? catalog.filter((exercise) => !existingExerciseIds.has(exercise.id))
        : catalog.filter(
            (exercise) =>
              exercise.id !== programExercise.exerciseId &&
              !existingExerciseIds.has(exercise.id) &&
              exercise.muscleGroup === programExercise.exercise.muscleGroup,
          );
    // Favourites lead the list (issue #404), search or not.
    if (!needle) return favoritesFirst(source);
    return favoritesFirst(
      source.filter(
        (exercise) =>
          matchesSearch(exercise.name, needle, locale) ||
          matchesSearch(exerciseName(exercise.name), needle, locale),
      ),
    );
  }, [
    catalog,
    exerciseName,
    existingExerciseIds,
    locale,
    programExercise.exercise.muscleGroup,
    programExercise.exerciseId,
    query,
    view,
  ]);

  function close(nextOpen: boolean) {
    if (busy && !nextOpen) return;
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setView('actions');
      setQuery('');
      setPendingReplacement(null);
      setPendingAddition(null);
    }
  }

  function openView(nextView: View) {
    setView(nextView);
    setQuery('');
    setPendingReplacement(null);
    setPendingAddition(null);
  }

  // The first "just today" change copies the workout onto the session, so the
  // rows get new ids. The runner then keeps its place by position.
  async function copiedRows(response: Response) {
    try {
      const body = (await response.json()) as { copied?: boolean };
      return body.copied === true;
    } catch {
      return false;
    }
  }

  async function replaceExercise(exercise: SessionCatalogExercise, scope: Scope) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const response = await fetch(rowUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scoped(replacementPayload(programExercise, exercise), scope)),
      });
      if (!response.ok) {
        toast.error(response.status === 409 ? t('duplicate') : t('replaceError'));
        return;
      }
      toast.success(t('replaced'));
      onOpenChange(false);
      setView('actions');
      setPendingReplacement(null);
      setQuery('');
      onChanged();
    } catch {
      toast.error(t('replaceError'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  // A replace always asks first: on a workout, just today or from now on; the
  // wording depends on whether sets were already logged on the old exercise.
  function requestReplacement(exercise: SessionCatalogExercise) {
    setPendingReplacement(exercise);
  }

  // A freestyle session adds at once; a workout asks just today or from now on.
  function requestAddition(exercise: SessionCatalogExercise) {
    if (freestyle) void addExercise(exercise, 'today');
    else setPendingAddition(exercise);
  }

  async function addExercise(exercise: SessionCatalogExercise, scope: Scope) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const response = await fetch(rowsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scoped(addedExerciseTargets(exercise), scope)),
      });
      if (!response.ok) {
        toast.error(response.status === 409 ? t('duplicate') : t('addError'));
        return;
      }
      toast.success(t('added'));
      onOpenChange(false);
      setView('actions');
      setPendingAddition(null);
      setQuery('');
      onChanged();
    } catch {
      toast.error(t('addError'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function removeExercise(scope: Scope) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const response = await fetch(freestyle ? rowUrl : rowUrl + '?scope=' + scope, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('remove failed');
      toast.success(t('removed'));
      const copied = await copiedRows(response);
      onOpenChange(false);
      setView('actions');
      setQuery('');
      // After a copy the neighbours' ids changed too; the runner's position
      // already lands on the next exercise.
      onChanged(
        copied
          ? undefined
          : {
              selectProgramExerciseId: next?.id ?? previous?.id,
              removedProgramExerciseId: programExercise.id,
            },
      );
    } catch {
      toast.error(t('removeError'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  // The confirm buttons of a change: one button on a freestyle session, the
  // two scopes on a workout ("Just today" first, the safe default).
  function scopeChoices(
    pick: (scope: Scope) => void,
    freestyleLabel: string,
    variant: 'default' | 'destructive' = 'default',
  ) {
    if (freestyle) {
      return (
        <Button
          type="button"
          className="min-h-tap"
          variant={variant}
          disabled={busy}
          onClick={() => pick('today')}
        >
          {freestyleLabel}
        </Button>
      );
    }
    return (
      <>
        <Button
          type="button"
          className="min-h-tap"
          variant={variant}
          disabled={busy}
          onClick={() => pick('today')}
        >
          {t('justToday')}
        </Button>
        <Button
          type="button"
          className="min-h-tap"
          variant="secondary"
          disabled={busy}
          onClick={() => pick('program')}
        >
          {t('fromNowOn')}
        </Button>
      </>
    );
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogTitle>
          {view === 'actions'
            ? t('actions')
            : view === 'replace'
              ? t('replace')
              : view === 'add'
                ? t('addExercises')
                : t('remove')}
        </DialogTitle>
        <DialogDescription>
          {freestyle
            ? t('freestyleScope')
            : view === 'actions'
              ? t('actionsDescription')
              : view === 'replace'
                ? t('replaceDescription')
                : view === 'add'
                  ? t('addDescription')
                  : t('removeDescription')}
        </DialogDescription>

        {view === 'actions' && (
          <div className="flex flex-col gap-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-tap justify-start"
              onClick={() => openView('replace')}
            >
              <Replace className="mr-2 size-4" aria-hidden />
              {t('replace')}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-tap justify-start"
              onClick={() => openView('add')}
            >
              <Plus className="mr-2 size-4" aria-hidden />
              {t('addExercises')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="min-h-tap justify-start"
              disabled={onlyExercise}
              aria-describedby={onlyExercise ? removeBlockedId : undefined}
              onClick={() => openView('removeConfirm')}
            >
              <Trash2 className="mr-2 size-4" aria-hidden />
              {t('remove')}
            </Button>
            {onlyExercise && (
              <p id={removeBlockedId} className="text-sm text-muted-foreground">
                {t('removeLastBlocked')}
              </p>
            )}
          </div>
        )}

        {view === 'removeConfirm' && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {freestyle
                ? loggedSetCount > 0
                  ? t('freestyleRemoveLoggedWarning')
                  : t('freestyleRemoveConfirm')
                : loggedSetCount > 0
                  ? t('removeLoggedWarning')
                  : t('removeConfirm')}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                className="min-h-tap"
                variant="outline"
                disabled={busy}
                onClick={() => setView('actions')}
              >
                {t('cancel')}
              </Button>
              {scopeChoices((scope) => void removeExercise(scope), t('remove'), 'destructive')}
            </div>
          </div>
        )}

        {view === 'add' && pendingAddition ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t('addConfirm', { name: exerciseName(pendingAddition.name) })}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                className="min-h-tap"
                variant="outline"
                disabled={busy}
                onClick={() => setPendingAddition(null)}
              >
                {t('cancel')}
              </Button>
              {scopeChoices((scope) => void addExercise(pendingAddition, scope), t('addExercises'))}
            </div>
          </div>
        ) : (view === 'replace' || view === 'add') && pendingReplacement ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {freestyle
                ? loggedSetCount > 0
                  ? t('freestyleReplaceLoggedWarning')
                  : t('freestyleReplaceConfirm')
                : loggedSetCount > 0
                  ? t('replaceLoggedWarning')
                  : t('replaceConfirm')}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                className="min-h-tap"
                variant="outline"
                disabled={busy}
                onClick={() => setPendingReplacement(null)}
              >
                {t('cancel')}
              </Button>
              {scopeChoices(
                (scope) => void replaceExercise(pendingReplacement, scope),
                t('confirmReplace', { name: exerciseName(pendingReplacement.name) }),
              )}
            </div>
          </div>
        ) : view === 'replace' || view === 'add' ? (
          <>
            <div className="relative">
              <Search
                className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('searchExercises')}
                className="pl-9"
                aria-label={t('searchExercises')}
              />
            </div>
            <div className="flex flex-col gap-1">
              {choices.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">{t('noExercises')}</p>
              ) : (
                choices.map((exercise) => (
                  <Button
                    key={exercise.id}
                    type="button"
                    variant="ghost"
                    className="min-h-tap justify-start"
                    disabled={busy}
                    onClick={() =>
                      view === 'replace' ? requestReplacement(exercise) : requestAddition(exercise)
                    }
                    aria-label={
                      exercise.isFavorite
                        ? t('favoriteChoice', { name: exerciseName(exercise.name) })
                        : undefined
                    }
                  >
                    {exercise.isFavorite && (
                      <Star className="size-4 fill-current text-amber-500" aria-hidden />
                    )}
                    {exerciseName(exercise.name)}
                  </Button>
                ))
              )}
            </div>
            <Button
              type="button"
              className="min-h-tap"
              variant="outline"
              disabled={busy}
              onClick={() => setView('actions')}
            >
              {t('back')}
            </Button>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
