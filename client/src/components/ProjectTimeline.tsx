import { cn } from '@/lib/cn';
import { Badge, ProgressBar } from '@/components/ui';
import type { Timeline } from '@/types/photo';

/**
 * Project timeline.
 *
 * Shows how a shoot actually progressed - requested, confirmed, deposit, shoot,
 * editing, highlights, gallery, selection, delivery - which is the question
 * clients ask most and the one a status badge cannot answer. The stage order and
 * progress come from the server's timeline engine, so this never drifts from the
 * rules that actually advance a project.
 */

interface ProjectTimelineProps {
  timeline: Timeline;
  className?: string;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function ProjectTimeline({ timeline, className }: ProjectTimelineProps) {
  const { stages, current, currentIndex, completed, percent, events } = timeline;
  const currentStage = stages[currentIndex];

  return (
    <div className={cn('space-y-6', className)}>
      {/*
        The whole stage list on one line: clients care that it is moving and how
        far along it is, not which of eleven steps is next.
      */}
      <div>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-medium text-white">
            {completed ? 'Completed' : (currentStage?.label ?? current)}
          </p>
          <p className="text-xs text-ink-400">{percent}%</p>
        </div>
        <ProgressBar value={percent} max={100} />
        <ol className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
          {stages.map((stage, index) => {
            const done = index < currentIndex || completed;
            const active = index === currentIndex && !completed;
            return (
              <li
                key={stage.key}
                aria-current={active ? 'step' : undefined}
                className={cn(
                  'text-[11px] uppercase tracking-wide',
                  active ? 'text-amber-300' : done ? 'text-ink-400' : 'text-ink-600',
                )}
              >
                {stage.short}
              </li>
            );
          })}
        </ol>
      </div>

      {events.length === 0 ? (
        <p className="text-sm text-ink-400">Nothing has happened on this project yet.</p>
      ) : (
        <ol className="relative space-y-6 border-l border-ink-800 pl-6">
          {events.map((event, index) => (
            <li key={event.id} className="relative">
              {/* The newest event is the emphasised dot - "where is this now". */}
              <span
                aria-hidden="true"
                className={cn(
                  'absolute -left-[31px] top-1 h-3 w-3 rounded-full border-2 border-ink-950',
                  index === events.length - 1 ? 'bg-amber-400' : 'bg-ink-600',
                )}
              />
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium text-white">{event.title}</p>
                {!event.automatic && <Badge tone="neutral">note</Badge>}
              </div>
              {event.description && <p className="mt-1 text-sm text-ink-300">{event.description}</p>}
              <p className="mt-1 text-xs text-ink-500">{formatWhen(event.occurredAt)}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}