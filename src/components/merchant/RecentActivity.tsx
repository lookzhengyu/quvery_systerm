import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Filter,
  History,
  RefreshCw,
  UserMinus,
  UserPlus,
  UserRoundCheck,
  UserRoundX,
} from 'lucide-react';
import { useQueue } from '../../context/useQueue';
import type { QueueEvent, QueueEventType } from '../../types';

type ActivityMode = 'summary' | 'history';
type ActivityFilter = 'all' | 'service' | 'system';
type ActivityTone = 'neutral' | 'success' | 'warning' | 'danger';

interface RecentActivityProps {
  mode?: ActivityMode;
  onViewAll?: () => void;
  onHide?: () => void;
}

interface ActivityItem {
  id: string;
  title: string;
  description: string;
  timestamp: string;
  eventType: QueueEventType;
  category: ActivityFilter;
  tone: ActivityTone;
  count: number;
}

const SUMMARY_LIMIT = 6;
const HISTORY_LIMIT = 150;
const GROUP_WINDOW_MS = 10 * 60 * 1000;

const EVENT_ICONS: Record<QueueEventType, typeof UserPlus> = {
  joined: UserPlus,
  called: Clock3,
  confirmed: UserRoundCheck,
  seated: CheckCircle2,
  expired: UserRoundX,
  left: UserMinus,
  removed: UserMinus,
  queue_cleared: RefreshCw,
};

const FILTER_OPTIONS: Array<{
  value: ActivityFilter;
  label: string;
}> = [
  { value: 'all', label: 'All' },
  { value: 'service', label: 'Queue' },
  { value: 'system', label: 'System' },
];

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return iso;
  }
}

function formatWait(waitMs: number | null): string {
  if (!waitMs || waitMs <= 0) {
    return '-';
  }

  const minutes = Math.max(1, Math.round(waitMs / 60000));
  return `${minutes} min`;
}

function queueLabel(event: QueueEvent): string {
  return typeof event.queueNumber === 'number' ? `#${event.queueNumber}` : 'A customer';
}

function getTableName(event: QueueEvent): string | null {
  const tableName = event.metadata?.tableName;
  return typeof tableName === 'string' && tableName.trim().length > 0 ? tableName.trim() : null;
}

function isMeaningfulForSummary(event: QueueEvent): boolean {
  if (event.eventType === 'removed' || event.eventType === 'left') {
    return false;
  }

  if (event.eventType === 'queue_cleared') {
    return Number(event.metadata?.clearedCustomers ?? 0) > 0;
  }

  return true;
}

function toActivityItem(event: QueueEvent): ActivityItem {
  const label = queueLabel(event);
  const tableName = getTableName(event);

  switch (event.eventType) {
    case 'joined':
      return {
        id: `event-${event.id}`,
        title: `${label} joined the queue`,
        description: `${event.partySize ?? '?'} pax added to the waitlist`,
        timestamp: event.createdAt,
        eventType: event.eventType,
        category: 'service',
        tone: 'neutral',
        count: 1,
      };
    case 'called':
      return {
        id: `event-${event.id}`,
        title: tableName ? `${label} called to ${tableName}` : `${label} was called`,
        description: `${event.partySize ?? '?'} pax notified to head over`,
        timestamp: event.createdAt,
        eventType: event.eventType,
        category: 'service',
        tone: 'warning',
        count: 1,
      };
    case 'confirmed':
      return {
        id: `event-${event.id}`,
        title: `${label} arrived`,
        description: `${event.partySize ?? '?'} pax confirmed they are here`,
        timestamp: event.createdAt,
        eventType: event.eventType,
        category: 'service',
        tone: 'success',
        count: 1,
      };
    case 'seated':
      return {
        id: `event-${event.id}`,
        title: tableName ? `${label} seated at ${tableName}` : `${label} seated`,
        description:
          event.waitMs && event.waitMs > 0
            ? `${event.partySize ?? '?'} pax seated after ${formatWait(event.waitMs)}`
            : `${event.partySize ?? '?'} pax seated`,
        timestamp: event.createdAt,
        eventType: event.eventType,
        category: 'service',
        tone: 'success',
        count: 1,
      };
    case 'expired':
      return {
        id: `event-${event.id}`,
        title: `${label} marked no-show`,
        description:
          event.waitMs && event.waitMs > 0
            ? `${event.partySize ?? '?'} pax missed the call after ${formatWait(event.waitMs)}`
            : `${event.partySize ?? '?'} pax did not respond in time`,
        timestamp: event.createdAt,
        eventType: event.eventType,
        category: 'service',
        tone: 'danger',
        count: 1,
      };
    case 'left':
      return {
        id: `event-${event.id}`,
        title: `${label} left the queue`,
        description: `${event.partySize ?? '?'} pax left before being seated`,
        timestamp: event.createdAt,
        eventType: event.eventType,
        category: 'service',
        tone: 'neutral',
        count: 1,
      };
    case 'removed':
      return {
        id: `event-${event.id}`,
        title: `${label} removed`,
        description: 'Removed manually by the merchant',
        timestamp: event.createdAt,
        eventType: event.eventType,
        category: 'system',
        tone: 'neutral',
        count: 1,
      };
    case 'queue_cleared': {
      const clearedCustomers = Number(event.metadata?.clearedCustomers ?? 0);
      return {
        id: `event-${event.id}`,
        title: 'Queue cleared',
        description:
          clearedCustomers > 0
            ? `${clearedCustomers} customer${clearedCustomers === 1 ? '' : 's'} removed from the live queue`
            : 'The queue was reset while no customers were waiting',
        timestamp: event.createdAt,
        eventType: event.eventType,
        category: 'system',
        tone: clearedCustomers > 0 ? 'warning' : 'neutral',
        count: 1,
      };
    }
    default:
      return {
        id: `event-${event.id}`,
        title: event.eventType,
        description: 'Queue activity updated',
        timestamp: event.createdAt,
        eventType: event.eventType,
        category: 'service',
        tone: 'neutral',
        count: 1,
      };
  }
}

function groupQueueClearedEvents(events: QueueEvent[]): ActivityItem[] {
  const grouped: ActivityItem[] = [];

  for (const event of events) {
    const current = toActivityItem(event);
    const previous = grouped[grouped.length - 1];
    const currentTime = Date.parse(current.timestamp);
    const previousTime = previous ? Date.parse(previous.timestamp) : Number.NaN;

    if (
      previous &&
      current.eventType === 'queue_cleared' &&
      previous.eventType === 'queue_cleared' &&
      Number.isFinite(currentTime) &&
      Number.isFinite(previousTime) &&
      Math.abs(previousTime - currentTime) <= GROUP_WINDOW_MS
    ) {
      const currentCleared = Number(event.metadata?.clearedCustomers ?? 0);
      const previousDescriptionCustomers = Number(
        previous.description.match(/(\d+)/)?.[1] ?? '0'
      );
      const combinedCount = previous.count + 1;
      const combinedCustomers = previousDescriptionCustomers + currentCleared;

      grouped[grouped.length - 1] = {
        ...previous,
        id: `${previous.id}-${event.id}`,
        count: combinedCount,
        title: `Queue cleared ${combinedCount} times`,
        description:
          combinedCustomers > 0
            ? `${combinedCustomers} total customer${combinedCustomers === 1 ? '' : 's'} removed across repeated clear actions`
            : 'Repeated clear actions were triggered while the queue was empty',
        tone: combinedCustomers > 0 ? 'warning' : 'neutral',
      };
      continue;
    }

    grouped.push(current);
  }

  return grouped;
}

function toneClasses(tone: ActivityTone): string {
  switch (tone) {
    case 'success':
      return 'border-emerald-500/20 bg-emerald-500/10';
    case 'warning':
      return 'border-amber-500/20 bg-amber-500/10';
    case 'danger':
      return 'border-rose-500/20 bg-rose-500/10';
    default:
      return 'border-slate-700/50 bg-slate-800/50';
  }
}

function iconClasses(tone: ActivityTone): string {
  switch (tone) {
    case 'success':
      return 'bg-emerald-500/15 text-emerald-300';
    case 'warning':
      return 'bg-amber-500/15 text-amber-300';
    case 'danger':
      return 'bg-rose-500/15 text-rose-300';
    default:
      return 'bg-slate-700 text-slate-200';
  }
}

function ActivityCard({ item, compact = false }: { item: ActivityItem; compact?: boolean }) {
  const EventIcon = EVENT_ICONS[item.eventType] ?? History;

  return (
    <div className={`min-w-0 rounded-xl border p-3 ${toneClasses(item.tone)}`}>
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${iconClasses(item.tone)}`}>
          <EventIcon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-2">
            <div className="min-w-0 flex-1">
              <p className={`font-medium text-white ${compact ? 'text-[13px]' : 'text-sm'}`}>
                {item.title}
              </p>
              <p className={`mt-0.5 text-slate-400 ${compact ? 'text-[11px]' : 'text-xs'}`}>
                {item.description}
              </p>
            </div>
            <span className="shrink-0 text-[11px] text-slate-500 sm:text-right">
              {formatTimestamp(item.timestamp)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function RecentActivity({
  mode = 'summary',
  onViewAll,
  onHide,
}: RecentActivityProps) {
  const { fetchQueueEvents, syncMode } = useQueue();
  const [events, setEvents] = useState<QueueEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<ActivityFilter>('all');

  const isSummary = mode === 'summary';

  const loadEvents = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const result = await fetchQueueEvents(isSummary ? HISTORY_LIMIT : 200);
      setEvents(result);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load recent activity.');
    } finally {
      setLoading(false);
    }
  }, [fetchQueueEvents, isSummary]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  const todayEvents = useMemo(() => {
    const today = new Date().toDateString();
    return events.filter(event => new Date(event.createdAt).toDateString() === today);
  }, [events]);

  const servedToday = todayEvents.filter(event => event.eventType === 'seated').length;
  const noShowsToday = todayEvents.filter(event => event.eventType === 'expired').length;
  const averageWaitMinutes = useMemo(() => {
    const seatedWaits = todayEvents
      .filter(
        event =>
          event.eventType === 'seated' &&
          typeof event.waitMs === 'number' &&
          event.waitMs > 0
      )
      .map(event => event.waitMs as number);

    if (seatedWaits.length === 0) {
      return null;
    }

    return Math.max(
      1,
      Math.round(
        seatedWaits.reduce((sum, waitMs) => sum + waitMs, 0) / seatedWaits.length / 60000
      )
    );
  }, [todayEvents]);

  const historyItems = useMemo(() => groupQueueClearedEvents(events), [events]);
  const summaryItemsSource = useMemo(
    () => groupQueueClearedEvents(events.filter(isMeaningfulForSummary)),
    [events]
  );

  const filteredItems = useMemo(() => {
    const source = isSummary ? summaryItemsSource : historyItems;

    if (filter === 'all') {
      return source;
    }

    return source.filter(item => item.category === filter);
  }, [filter, historyItems, isSummary, summaryItemsSource]);

  const summaryItems = useMemo(() => filteredItems.slice(0, SUMMARY_LIMIT), [filteredItems]);

  if (syncMode === 'local') {
    return (
      <div className="flex h-full flex-col items-center justify-center py-10 text-center">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-800">
          <History className="h-6 w-6 text-slate-600" />
        </div>
        <p className="text-sm text-slate-400">Recent activity is only available in remote mode.</p>
      </div>
    );
  }

  const header = isSummary ? 'Recent Activity' : 'Activity History';

  return (
    <div className={`space-y-3 ${isSummary ? 'h-full' : ''}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white">{header}</p>
          <p className="mt-0.5 text-xs text-slate-500">
            {isSummary
              ? 'Only the latest meaningful changes are shown here.'
              : 'Full service history with filters and grouped repeats.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isSummary && onHide && (
            <button
              id="hideRecentActivityBtn"
              type="button"
              onClick={onHide}
              className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-slate-400 transition-colors hover:bg-slate-800 hover:text-white sm:min-h-0"
            >
              Hide
            </button>
          )}
          {!isSummary && (
            <div className="hidden items-center gap-1 rounded-lg border border-slate-800 bg-slate-900/70 p-1 sm:flex">
              <Filter className="ml-1 h-3.5 w-3.5 text-slate-500" />
              {FILTER_OPTIONS.map(option => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setFilter(option.value)}
                  className={`rounded-md px-2 py-1 text-[11px] font-semibold transition-colors ${
                    filter === option.value
                      ? 'bg-indigo-600 text-white'
                      : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
          <button
            id={isSummary ? 'refreshRecentActivityBtn' : 'refreshActivityHistoryBtn'}
            onClick={() => {
              void loadEvents();
            }}
            className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-slate-400 transition-colors hover:bg-slate-800 hover:text-white sm:min-h-0"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3">
          <p className="text-[11px] uppercase tracking-wide text-emerald-300">Served Today</p>
          <p className="mt-1 text-xl font-bold text-white">{servedToday}</p>
        </div>
        <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 p-3">
          <p className="text-[11px] uppercase tracking-wide text-rose-300">No-Shows</p>
          <p className="mt-1 text-xl font-bold text-white">{noShowsToday}</p>
        </div>
        <div className="rounded-xl border border-sky-500/20 bg-sky-500/10 p-3">
          <p className="text-[11px] uppercase tracking-wide text-sky-300">Avg Wait</p>
          <p className="mt-1 text-xl font-bold text-white">
            {averageWaitMinutes ? `${averageWaitMinutes}m` : '-'}
          </p>
        </div>
      </div>

      {!isSummary && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-500">
            {filteredItems.length} grouped item{filteredItems.length !== 1 ? 's' : ''}
          </span>
          <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-900/70 p-1 sm:hidden">
            {FILTER_OPTIONS.map(option => (
              <button
                key={option.value}
                type="button"
                onClick={() => setFilter(option.value)}
                className={`rounded-md px-2 py-1 text-[11px] font-semibold transition-colors ${
                  filter === option.value
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          {error}
        </div>
      )}

      {loading && events.length === 0 ? (
        <div className="flex items-center justify-center py-10">
          <RefreshCw className="h-5 w-5 animate-spin text-slate-400" />
        </div>
      ) : (isSummary ? summaryItems : filteredItems).length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-800">
            {isSummary ? (
              <Clock3 className="h-6 w-6 text-slate-600" />
            ) : (
              <History className="h-6 w-6 text-slate-600" />
            )}
          </div>
          <p className="text-sm text-slate-400">
            {isSummary ? 'No important activity yet.' : 'No activity found for this filter.'}
          </p>
          <p className="mt-1 text-xs text-slate-600">
            {isSummary
              ? 'Queue actions worth watching will appear here.'
              : 'Try another filter or come back after service starts.'}
          </p>
        </div>
      ) : (
        <>
          <div className={`space-y-2 ${isSummary ? 'max-h-[18rem] overflow-y-auto pr-1' : ''}`}>
            {(isSummary ? summaryItems : filteredItems).map(item => (
              <ActivityCard key={item.id} item={item} compact={isSummary} />
            ))}
          </div>

          {isSummary && (
            <div className="flex flex-col gap-2 border-t border-slate-800 pt-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex items-start gap-2 text-xs text-slate-500">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 text-slate-600" />
                <p>
                  Hidden from the dashboard: low-value removals, queue exits, and repeated system noise.
                </p>
              </div>
              {onViewAll && (
                <button
                  id="viewAllActivityBtn"
                  type="button"
                  onClick={onViewAll}
                  className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs font-semibold text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-700 sm:min-h-0"
                >
                  View all
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
