import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Armchair,
  ChevronDown,
  Clock,
  PhoneCall,
  RotateCcw,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import { useQueue } from '../../context/useQueue';
import type { Customer, SyncStatus } from '../../types';
import { findBestTable } from '../../utils/tableMatching';
import { getTableDisplayMeta } from '../../utils/tableLabels';
import ConfirmDialog from './ConfirmDialog';
import AddCustomerForm from './AddCustomerForm';

const COUNTDOWN_SECONDS = 60;
const EXPIRED_VISIBLE_MS = 1000 * 60 * 5;

const STATUS_CONFIG = {
  waiting: { label: 'Wait', classes: 'bg-slate-700 text-slate-300' },
  called: {
    label: 'Called',
    classes: 'border border-amber-500/30 bg-amber-500/20 text-amber-300',
  },
  confirmed: {
    label: 'Here',
    classes: 'border border-emerald-500/30 bg-emerald-500/20 text-emerald-300',
  },
  seated: {
    label: 'Seated',
    classes: 'border border-blue-500/30 bg-blue-500/20 text-blue-300',
  },
  expired: {
    label: 'Expired',
    classes: 'border border-rose-500/30 bg-rose-500/20 text-rose-300',
  },
};

const SYNC_STATUS_COPY: Partial<Record<SyncStatus, string>> = {
  offline: 'Queue server is offline. Actions may fail until the connection returns.',
  error: 'The last merchant action failed. Please retry.',
  'conflict-refreshed': 'Another device changed the queue. The latest state has been loaded.',
};

function maskPhone(phone: string): string {
  if (phone.length <= 4) {
    return phone;
  }

  return phone.slice(0, -4).replace(/./g, '*') + phone.slice(-4);
}

function getCustomerDisplayLabel(customer: Customer): string {
  if (customer.source === 'walk-in') {
    return customer.name?.trim() ? customer.name.trim() : 'Walk-in guest';
  }

  return customer.phone ? maskPhone(customer.phone) : 'Guest';
}

function formatWaitTime(joinTime: Date): string {
  const minutes = Math.floor((Date.now() - joinTime.getTime()) / 60000);

  if (minutes < 1) {
    return 'now';
  }

  if (minutes === 1) {
    return '1m';
  }

  return `${minutes}m`;
}

function useCallCountdown(callTime: Date | undefined): {
  secondsRemaining: number;
  progress: number;
} {
  const [now, setNow] = useState(() => Date.now());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!callTime) {
      return undefined;
    }

    intervalRef.current = setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [callTime]);

  if (!callTime) {
    return { secondsRemaining: COUNTDOWN_SECONDS, progress: 100 };
  }

  const elapsed = Math.floor((now - callTime.getTime()) / 1000);
  const remaining = Math.max(0, COUNTDOWN_SECONDS - elapsed);
  return {
    secondsRemaining: remaining,
    progress: (remaining / COUNTDOWN_SECONDS) * 100,
  };
}

function CountdownBar({ callTime }: { callTime: Date | undefined }) {
  const { secondsRemaining, progress } = useCallCountdown(callTime);

  const barColor =
    progress > 50
      ? 'bg-amber-500'
      : progress > 25
        ? 'bg-orange-500'
        : 'bg-rose-500';

  return (
    <div className="mt-1 flex items-center gap-1.5">
      <div className="qf-countdown-track flex-1">
        <div
          className={`qf-countdown-bar ${barColor}`}
          style={{ width: `${progress}%` }}
        />
      </div>
      <span
        className={`text-[9px] font-bold tabular-nums ${
          secondsRemaining <= 15 ? 'text-rose-400 animate-countdown-pulse' : 'text-amber-400'
        }`}
      >
        {secondsRemaining}s
      </span>
    </div>
  );
}

interface CustomerRowProps {
  customer: Customer;
  assignedTableLabel?: string;
  canCall: boolean;
  onCall: () => void;
  onSeat: () => void;
  onExpire: () => void;
  onRequeue: () => void;
  onRemove: () => void;
}

function CustomerRow({
  customer,
  assignedTableLabel,
  canCall,
  onCall,
  onSeat,
  onExpire,
  onRequeue,
  onRemove,
}: CustomerRowProps) {
  const config = STATUS_CONFIG[customer.status];
  const isWaiting = customer.status === 'waiting';
  const isCalled = customer.status === 'called';
  const isConfirmed = customer.status === 'confirmed';
  const isExpired = customer.status === 'expired';

  return (
    <div
      className={`min-w-0 rounded-md border px-2.5 py-2 transition-all duration-200 animate-fade-in sm:px-2 sm:py-1.5 ${
        isCalled
          ? 'border-amber-500/25 bg-amber-500/5'
          : isConfirmed
            ? 'border-emerald-500/25 bg-emerald-500/5'
            : isExpired
              ? 'border-rose-500/20 bg-rose-500/5 opacity-60'
              : 'border-slate-700/50 bg-slate-800/40'
      }`}
    >
      {/* Top line: queue #, phone, status badge, pax, wait time */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-slate-700/80 text-[9px] font-bold text-white">
          {customer.queueNumber}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-white sm:text-[11px]">
          {getCustomerDisplayLabel(customer)}
        </span>
        <span className={`shrink-0 rounded px-1 py-0.5 text-[8px] font-semibold uppercase ${config.classes}`}>
          {config.label}
        </span>
        {customer.source === 'walk-in' && (
          <span className="shrink-0 rounded border border-emerald-500/30 bg-emerald-500/10 px-1 py-0.5 text-[8px] font-semibold uppercase text-emerald-300">
            Walk-in
          </span>
        )}
        {assignedTableLabel && (
          <span className="rounded bg-indigo-500/15 px-1 py-0.5 font-mono text-[8px] font-semibold text-indigo-200">
            {assignedTableLabel}
          </span>
        )}
        <span className="ml-0 flex items-center gap-0.5 text-[10px] text-slate-500 sm:ml-auto sm:text-[9px]">
          <Users className="h-2.5 w-2.5" />{customer.partySize}
        </span>
        <span className="flex items-center gap-0.5 text-[10px] text-slate-500 sm:text-[9px]">
          <Clock className="h-2.5 w-2.5" />{formatWaitTime(customer.joinTime)}
        </span>
      </div>

      {/* Countdown bar for called customers */}
      {isCalled && <CountdownBar callTime={customer.callTime} />}

      {/* Action buttons – always visible (no hover-only) */}
      <div className="mt-2 grid grid-cols-2 gap-1 sm:mt-1 sm:flex sm:flex-wrap sm:items-center">
        {/* WAITING: Call + Remove */}
        {isWaiting && (
          <>
            <button
              id={`call-${customer.id}`}
              onClick={onCall}
              disabled={!canCall}
              title={canCall ? 'Call customer' : 'No suitable table'}
              className="flex min-h-8 w-full items-center justify-center gap-1 rounded bg-indigo-600 px-2 py-1 text-[10px] font-semibold text-white shadow-sm transition-all active:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500 sm:min-h-0 sm:w-auto sm:py-0.5 sm:text-[9px]"
            >
              <PhoneCall className="h-2.5 w-2.5" />
              Call
            </button>
            <button
              id={`remove-${customer.id}`}
              onClick={onRemove}
              className="flex min-h-8 w-full items-center justify-center gap-1 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-[10px] font-semibold text-slate-300 transition-all active:bg-slate-700 sm:min-h-0 sm:w-auto sm:py-0.5 sm:text-[9px]"
            >
              <X className="h-2.5 w-2.5" />
              Remove
            </button>
          </>
        )}

        {/* CALLED: Re-call + Seat + Requeue + No-show */}
        {isCalled && (
          <>
            <button
              id={`recall-${customer.id}`}
              onClick={onCall}
              className="flex min-h-8 w-full items-center justify-center gap-1 rounded bg-amber-600 px-2 py-1 text-[10px] font-semibold text-white shadow-sm transition-all active:bg-amber-500 sm:min-h-0 sm:w-auto sm:py-0.5 sm:text-[9px]"
            >
              <PhoneCall className="h-2.5 w-2.5" />
              Re-call
            </button>
            <button
              id={`seat-called-${customer.id}`}
              onClick={onSeat}
              className="flex min-h-8 w-full items-center justify-center gap-1 rounded bg-emerald-600 px-2 py-1 text-[10px] font-semibold text-white shadow-sm transition-all active:bg-emerald-500 sm:min-h-0 sm:w-auto sm:py-0.5 sm:text-[9px]"
            >
              <Armchair className="h-2.5 w-2.5" />
              Seat
            </button>
            <button
              id={`requeue-${customer.id}`}
              onClick={onRequeue}
              className="flex min-h-8 w-full items-center justify-center gap-1 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-[10px] font-semibold text-slate-200 transition-all active:bg-slate-700 sm:min-h-0 sm:w-auto sm:py-0.5 sm:text-[9px]"
            >
              <RotateCcw className="h-2.5 w-2.5" />
              Requeue
            </button>
            <button
              id={`noshow-${customer.id}`}
              onClick={onExpire}
              className="flex min-h-8 w-full items-center justify-center gap-1 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[10px] font-semibold text-rose-300 transition-all active:bg-rose-500/20 sm:min-h-0 sm:w-auto sm:py-0.5 sm:text-[9px]"
            >
              <XCircle className="h-2.5 w-2.5" />
              No-show
            </button>
          </>
        )}

        {/* CONFIRMED: Seat + Requeue + No-show */}
        {isConfirmed && (
          <>
            <button
              id={`seat-${customer.id}`}
              onClick={onSeat}
              className="flex min-h-8 w-full items-center justify-center gap-1 rounded bg-emerald-600 px-2 py-1 text-[10px] font-semibold text-white shadow-sm transition-all active:bg-emerald-500 sm:min-h-0 sm:w-auto sm:py-0.5 sm:text-[9px]"
            >
              <Armchair className="h-2.5 w-2.5" />
              Seat
            </button>
            <button
              id={`requeue-confirmed-${customer.id}`}
              onClick={onRequeue}
              className="flex min-h-8 w-full items-center justify-center gap-1 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-[10px] font-semibold text-slate-200 transition-all active:bg-slate-700 sm:min-h-0 sm:w-auto sm:py-0.5 sm:text-[9px]"
            >
              <RotateCcw className="h-2.5 w-2.5" />
              Requeue
            </button>
            <button
              id={`noshow-confirmed-${customer.id}`}
              onClick={onExpire}
              className="flex min-h-8 w-full items-center justify-center gap-1 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[10px] font-semibold text-rose-300 transition-all active:bg-rose-500/20 sm:min-h-0 sm:w-auto sm:py-0.5 sm:text-[9px]"
            >
              <X className="h-2.5 w-2.5" />
              No-show
            </button>
          </>
        )}

        {/* EXPIRED: Requeue + Remove */}
        {isExpired && (
          <>
            <button
              id={`requeue-expired-${customer.id}`}
              onClick={onRequeue}
              className="flex min-h-8 w-full items-center justify-center gap-1 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-[10px] font-semibold text-slate-200 transition-all active:bg-slate-700 sm:min-h-0 sm:w-auto sm:py-0.5 sm:text-[9px]"
            >
              <RotateCcw className="h-2.5 w-2.5" />
              Requeue
            </button>
            <button
              id={`remove-expired-${customer.id}`}
              onClick={onRemove}
              className="flex min-h-8 w-full items-center justify-center gap-1 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[10px] font-semibold text-rose-300 transition-all active:bg-rose-500/20 sm:min-h-0 sm:w-auto sm:py-0.5 sm:text-[9px]"
            >
              <X className="h-2.5 w-2.5" />
              Remove
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default function CustomerQueue() {
  const {
    autoMode,
    callCustomer,
    customers,
    expireCustomer,
    removeCustomer,
    requeueCustomer,
    seatCustomer,
    syncMode,
    syncStatus,
    tables,
  } = useQueue();
  const [actionError, setActionError] = useState('');
  const [confirmTarget, setConfirmTarget] = useState<{
    id: string;
    action: 'remove';
    label: string;
  } | null>(null);
  const [showSeated, setShowSeated] = useState(false);
  const [expiredVisibilityNow, setExpiredVisibilityNow] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setExpiredVisibilityNow(Date.now());
    }, 30000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  const runAction = async (action: () => Promise<void>) => {
    setActionError('');

    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to update the queue right now.');
    }
  };

  const activeCustomers = useMemo(
    () =>
      [...customers]
        .filter(customer => customer.status !== 'seated')
        .filter(customer => {
          if (customer.status !== 'expired') {
            return true;
          }

          if (!customer.expiredAt) {
            return true;
          }

          return expiredVisibilityNow - customer.expiredAt.getTime() < EXPIRED_VISIBLE_MS;
        })
        .sort((left, right) => {
          // Sort priority: called > confirmed > waiting > expired
          const priority: Record<string, number> = {
            called: 0,
            confirmed: 1,
            waiting: 2,
            expired: 3,
          };
          const leftP = priority[left.status] ?? 4;
          const rightP = priority[right.status] ?? 4;
          if (leftP !== rightP) return leftP - rightP;
          return left.queueNumber - right.queueNumber;
        }),
    [customers, expiredVisibilityNow]
  );

  const seatedCustomers = useMemo(
    () => customers.filter(customer => customer.status === 'seated' && Boolean(customer.assignedTableId)),
    [customers]
  );

  const waitingCount = activeCustomers.filter(c => c.status === 'waiting').length;
  const calledCount = activeCustomers.filter(c => c.status === 'called').length;
  const noTablesAvailable = tables.filter(t => t.status === 'available').length === 0;

  return (
    <div className="space-y-1.5">
      {syncMode === 'remote' && syncStatus !== 'connected' && SYNC_STATUS_COPY[syncStatus] && (
        <div className="rounded-md border border-sky-500/20 bg-sky-500/10 px-2 py-1 text-[10px] text-sky-200">
          {SYNC_STATUS_COPY[syncStatus]}
        </div>
      )}

      {actionError && (
        <div className="rounded-md border border-rose-500/20 bg-rose-500/10 px-2 py-1 text-[10px] text-rose-200">
          {actionError}
        </div>
      )}

      {/* Walk-in Add Form */}
      <AddCustomerForm />

      {/* Warning: customers waiting but no tables */}
      {waitingCount > 0 && noTablesAvailable && calledCount === 0 && (
        <div className="flex items-center gap-1.5 rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-200">
          <AlertTriangle className="h-3 w-3 flex-shrink-0" />
          {autoMode ? 'All tables occupied. Auto Mode will call the next guest once a table opens.' : 'All tables occupied. Customers called once freed.'}
        </div>
      )}

      {activeCustomers.length === 0 && seatedCustomers.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-4 text-center">
          <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-lg bg-slate-800">
            <Users className="h-4 w-4 text-slate-600" />
          </div>
          <p className="text-[11px] font-medium text-slate-400">No customers in queue</p>
          <p className="mt-0.5 text-[10px] text-slate-600">Use form above or share portal</p>
        </div>
      ) : (
        <>
          {activeCustomers.map(customer => (
            <CustomerRow
              key={customer.id}
              customer={customer}
              assignedTableLabel={
                customer.assignedTableId
                  ? getTableDisplayMeta(
                      tables.find(table => table.id === customer.assignedTableId) ?? {
                        id: customer.assignedTableId,
                        name: customer.assignedTableId,
                        capacity: customer.partySize,
                        status: 'available',
                      },
                      tables
                    ).label
                  : undefined
              }
              canCall={findBestTable(customer.partySize, tables) !== null}
              onCall={() => {
                void runAction(() => callCustomer(customer.id));
              }}
              onSeat={() => {
                void runAction(() => seatCustomer(customer.id));
              }}
              onExpire={() => {
                void runAction(() => expireCustomer(customer.id));
              }}
              onRequeue={() => {
                void runAction(() => requeueCustomer(customer.id));
              }}
              onRemove={() => {
                setConfirmTarget({
                  id: customer.id,
                  action: 'remove',
                  label: `#${customer.queueNumber}`,
                });
              }}
            />
          ))}

          {/* Seated section */}
          {seatedCustomers.length > 0 && (
            <div className="mt-2">
              <button
                id="toggleSeatedSection"
                onClick={() => setShowSeated(prev => !prev)}
                className="mb-1 flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-[10px] font-semibold text-slate-400 transition-colors active:bg-slate-800 active:text-slate-200"
              >
                <Armchair className="h-3 w-3" />
                Seated ({seatedCustomers.length})
                <ChevronDown
                  className={`ml-auto h-3 w-3 transition-transform ${showSeated ? 'rotate-180' : ''}`}
                />
              </button>
              {showSeated && (
                <div className="space-y-1 animate-fade-in">
                  {seatedCustomers.map(customer => (
                    <div
                      key={customer.id}
                    className="flex flex-wrap items-center gap-2 rounded-md border border-blue-500/10 bg-blue-500/5 px-2 py-1 opacity-60"
                    >
                      <span className="text-[9px] font-bold text-blue-300">#{customer.queueNumber}</span>
                      <span className="text-[10px] text-slate-300">{getCustomerDisplayLabel(customer)}</span>
                      <span className="text-[9px] text-slate-500">{customer.partySize}p</span>
                      <span className="ml-auto rounded bg-blue-500/20 px-1 py-0.5 text-[8px] font-semibold text-blue-300">
                        Dining
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        isOpen={confirmTarget !== null}
        title="Remove Customer"
        description={`Remove customer ${confirmTarget?.label ?? ''} from the queue? This action cannot be undone.`}
        confirmLabel="Remove"
        variant="danger"
        onConfirm={() => {
          if (confirmTarget) {
            void runAction(() => removeCustomer(confirmTarget.id));
          }
          setConfirmTarget(null);
        }}
        onCancel={() => setConfirmTarget(null)}
      />
    </div>
  );
}
