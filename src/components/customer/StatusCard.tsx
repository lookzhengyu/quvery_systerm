import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Armchair,
  Bell,
  BellRing,
  CheckCircle2,
  ChevronLeft,
  Clock,
  Hourglass,
  PartyPopper,
  Users,
  UtensilsCrossed,
  XCircle,
} from 'lucide-react';
import { useQueue } from '../../context/useQueue';
import { useCountdown } from '../../hooks/useCountdown';
import type { Customer, SyncStatus } from '../../types';
import { getTableDisplayMeta } from '../../utils/tableLabels';
import {
  syncCustomerPushSubscription,
  type PushSyncResult,
} from '../../utils/pushNotifications';

interface StatusCardProps {
  customer: Customer;
  onLeave: () => Promise<void> | void;
  onRejoin: () => Promise<void> | void;
}

interface CountdownRingProps {
  seconds: number;
  progress: number;
}

const SYNC_STATUS_COPY: Partial<Record<SyncStatus, string>> = {
  syncing: 'Syncing your live queue status.',
  offline: 'Connection lost. Your screen may be showing the last cached queue status.',
  error: 'The last queue request failed. Please try again.',
  'conflict-refreshed': 'Queue data was refreshed after another device made a change.',
};
const queueNotificationIcon = new URL('../../assets/vite.svg', import.meta.url).toString();

function getPushSyncIssueCopy(result: PushSyncResult): string | null {
  if (result.ok) {
    return null;
  }

  switch (result.reason) {
    case 'ios-needs-home-screen':
      return 'iPhone alerts need the Home Screen app. Open this queue in Safari, tap Share, add it to Home Screen, then open QueueFlow from that icon.';
    case 'missing-vapid-key':
      return 'Push alerts are not configured on this deployment yet. Keep this page open or use email backup.';
    case 'insecure-context':
      return 'Open the HTTPS live link to receive phone alerts.';
    case 'permission-denied':
      return 'Notifications are blocked on this device. Enable them in phone or browser settings to receive call alerts.';
    case 'permission-pending':
      return 'Enable notifications before leaving this page to receive a background call alert.';
    case 'unsupported':
      return 'This browser cannot receive background web push alerts. Keep this page open or use email backup.';
    case 'missing-customer-token':
    case 'sync-failed':
      return 'This phone could not register for background alerts. Keep this page open or use email backup.';
    default:
      return null;
  }
}

function CountdownRing({ seconds, progress }: CountdownRingProps) {
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const strokeDashOffset = circumference - (progress / 100) * circumference;
  const color = progress > 50 ? '#f59e0b' : progress > 25 ? '#f97316' : '#ef4444';

  return (
    <div className="relative flex items-center justify-center">
      <svg width={100} height={100} className="-rotate-90">
        <circle cx={50} cy={50} r={radius} fill="none" stroke="#1e293b" strokeWidth={8} />
        <circle
          cx={50}
          cy={50}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={8}
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashOffset}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 1s linear, stroke 0.5s' }}
        />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="text-2xl font-bold leading-none text-white">{seconds}</span>
        <span className="text-xs text-slate-400">secs</span>
      </div>
    </div>
  );
}

/** Play a short notification chime using Web Audio API */
function playNotificationChime() {
  try {
    const audioCtx = new (
      window.AudioContext ||
      (window as unknown as Record<string, typeof AudioContext>).webkitAudioContext
    )();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, audioCtx.currentTime);
    osc.frequency.setValueAtTime(1100, audioCtx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.5);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.5);
  } catch {
    // Audio not available, silently ignore
  }
}

/** Vibrate if supported */
function triggerVibration() {
  try {
    if (navigator.vibrate) {
      navigator.vibrate([200, 100, 200, 100, 300]);
    }
  } catch {
    // Vibration not available
  }
}

/** Request notification permission and send a browser notification */
function sendBrowserNotification(storeName: string, tableLabel?: string) {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;

  try {
    const body = tableLabel
      ? `${tableLabel} is being held for you at ${storeName}. Please confirm your arrival.`
      : `Your table is ready at ${storeName}! Please confirm your arrival.`;

    new Notification(`QueueFlow | ${storeName}`, {
      body,
      icon: queueNotificationIcon,
      tag: 'queueflow-called',
      requireInteraction: true,
    });
  } catch {
    // Notification not available
  }
}

export default function StatusCard({ customer, onLeave, onRejoin }: StatusCardProps) {
  const {
    auth,
    confirmArrival,
    expireCustomer,
    getEstimatedWait,
    getWaitingAhead,
    syncMode,
    syncStatus,
    tables,
  } = useQueue();
  const [actionError, setActionError] = useState('');
  const [pushSyncResult, setPushSyncResult] = useState<PushSyncResult | null>(null);
  const calledNotifiedRef = useRef(false);
  const prevStatusRef = useRef(customer.status);

  const storeName = auth.storeName || 'Restaurant';
  const pushSyncIssueCopy = pushSyncResult ? getPushSyncIssueCopy(pushSyncResult) : null;

  const runAction = useCallback(async (action: () => Promise<void> | void) => {
    setActionError('');

    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to update your queue status.');
    }
  }, []);

  const handleExpire = useCallback(() => {
    void runAction(() => expireCustomer(customer.id));
  }, [customer.id, expireCustomer, runAction]);

  const { isExpired, progress, secondsRemaining } = useCountdown(
    customer.status === 'called' ? customer.callTime : undefined,
    handleExpire
  );

  useEffect(() => {
    let isActive = true;

    void syncCustomerPushSubscription({
      storeId: auth.storeId,
      customerId: customer.id,
      requestPermission: false,
    })
      .then(result => {
        if (isActive) {
          setPushSyncResult(result);
        }
      })
      .catch(() => {
        if (isActive) {
          setPushSyncResult({ ok: false, reason: 'sync-failed' });
        }
      });

    return () => {
      isActive = false;
    };
  }, [auth.storeId, customer.id]);

  // Trigger notifications when status changes to 'called'
  useEffect(() => {
    if (customer.status === 'called' && prevStatusRef.current !== 'called' && !calledNotifiedRef.current) {
      calledNotifiedRef.current = true;
      playNotificationChime();
      triggerVibration();

      const assignedTable = customer.assignedTableId
        ? tables.find(t => t.id === customer.assignedTableId)
        : undefined;
      const tableLabel = assignedTable ? getTableDisplayMeta(assignedTable, tables).label : undefined;
      sendBrowserNotification(storeName, tableLabel);
    }

    if (customer.status !== 'called') {
      calledNotifiedRef.current = false;
    }

    prevStatusRef.current = customer.status;
  }, [customer.status, customer.assignedTableId, storeName, tables]);

  const waitingAhead = getWaitingAhead(customer);
  const estimatedWait = getEstimatedWait(customer);
  const assignedTable = customer.assignedTableId
    ? tables.find(table => table.id === customer.assignedTableId)
    : undefined;
  const assignedTableMeta = assignedTable ? getTableDisplayMeta(assignedTable, tables) : null;
  const leaveLabel = customer.status === 'seated' ? 'Back' : 'Leave Queue';

  const renderWaiting = () => (
    <div className="space-y-5 animate-fade-in">
      <div className="py-6 text-center">
        <p className="mb-1 text-sm text-slate-500">Your Queue Number</p>
        <div className="inline-flex items-center justify-center">
          <span className="text-7xl font-black tracking-tighter text-white">
            #{customer.queueNumber}
          </span>
        </div>
        <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-slate-700/60 px-3 py-1">
          <Hourglass className="h-3.5 w-3.5 animate-pulse text-indigo-400" />
          <span className="text-xs font-medium text-indigo-300">In Queue</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-slate-700/50 bg-slate-800/60 p-3.5 text-center">
          <p className="mb-1 flex items-center justify-center gap-1 text-xs text-slate-400">
            <Users className="h-3 w-3" />
            Ahead of you
          </p>
          <p className="text-2xl font-bold text-white">{waitingAhead}</p>
        </div>
        <div className="rounded-xl border border-slate-700/50 bg-slate-800/60 p-3.5 text-center">
          <p className="mb-1 flex items-center justify-center gap-1 text-xs text-slate-400">
            <Clock className="h-3 w-3" />
            Est. wait
          </p>
          <p className="text-2xl font-bold text-white">
            {estimatedWait === 0 ? '<1' : estimatedWait}
            <span className="text-base font-normal text-slate-400"> min</span>
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3 rounded-xl border border-slate-700/40 bg-slate-800/40 p-3.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-500/20">
          <Users className="h-4.5 w-4.5 text-indigo-400" />
        </div>
        <div>
          <p className="text-sm font-medium text-white">Party of {customer.partySize}</p>
          <p className="text-xs text-slate-500">We'll notify you when your table is ready</p>
        </div>
        <Bell className="ml-auto h-4 w-4 animate-pulse-slow text-slate-600" />
      </div>
    </div>
  );

  const renderCalled = () => (
    <div className="space-y-5 animate-bounce-in">
      <div className="rounded-2xl border border-amber-500/30 bg-amber-500/15 p-4 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500/20">
          <BellRing className="h-6 w-6 animate-bounce text-amber-400" />
        </div>
        <h3 className="text-lg font-bold text-white">Your table is ready!</h3>
        <p className="mt-1 text-sm text-amber-300/80">
          {assignedTableMeta
            ? 'Go to your assigned table reference and confirm once you arrive.'
            : 'Please proceed to the host stand now.'}
        </p>
      </div>

      <div className="text-center">
        <p className="mb-3 text-sm text-slate-400">Time remaining to confirm</p>
        <CountdownRing seconds={secondsRemaining} progress={progress} />
      </div>

      <button
        id="imHereBtn"
        onClick={() => {
          void runAction(() => confirmArrival(customer.id));
        }}
        disabled={isExpired}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 py-4 text-base font-bold text-white shadow-lg shadow-emerald-500/30 transition-all duration-200 hover:-translate-y-0.5 hover:from-emerald-400 hover:to-teal-400 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <CheckCircle2 className="h-5 w-5" />
        I'm Here
      </button>
    </div>
  );

  const renderConfirmed = () => (
    <div className="space-y-4 py-4 text-center animate-bounce-in">
      <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-emerald-500/20">
        <CheckCircle2 className="h-10 w-10 text-emerald-400" />
      </div>
      <div>
        <h3 className="text-xl font-bold text-white">Arrival Confirmed!</h3>
        <p className="mt-1 text-sm text-slate-400">
          {assignedTableMeta
            ? 'Stay nearby while the host walks your party to the table.'
            : 'Your table is being prepared.'}
        </p>
      </div>
      <div className="flex items-center justify-center gap-2 text-sm font-medium text-emerald-400 animate-pulse">
        <Armchair className="h-4 w-4" />
        Waiting for host to seat you
      </div>
    </div>
  );

  const renderSeated = () => (
    <div className="space-y-4 py-4 text-center animate-bounce-in">
      <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-indigo-500/20">
        <PartyPopper className="h-10 w-10 text-indigo-400" />
      </div>
      <div>
        <h3 className="flex items-center justify-center gap-2 text-xl font-bold text-white">
          <PartyPopper className="h-5 w-5 text-indigo-400" />
          Enjoy your meal!
        </h3>
        <p className="mt-1 text-sm text-slate-400">
          {assignedTableMeta
            ? `You have been seated at ${assignedTableMeta.label}. Thank you for dining with us!`
            : 'You have been seated. Thank you for dining with us!'}
        </p>
      </div>
    </div>
  );

  const renderExpired = () => (
    <div className="space-y-5 text-center animate-fade-in">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-rose-500/20">
        <XCircle className="h-8 w-8 text-rose-400" />
      </div>
      <div>
        <h3 className="text-lg font-bold text-white">Time's up</h3>
        <p className="mt-1 text-sm text-slate-400">
          Your slot has expired. You can rejoin the queue.
        </p>
      </div>
      <button
        id="rejoinBtn"
        onClick={() => {
          void runAction(onRejoin);
        }}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 py-3.5 text-sm font-semibold text-white transition-all duration-200 hover:-translate-y-0.5 hover:bg-indigo-500"
      >
        Rejoin Queue
      </button>
    </div>
  );

  const renderContent = () => {
    switch (customer.status) {
      case 'waiting':
        return renderWaiting();
      case 'called':
        return renderCalled();
      case 'confirmed':
        return renderConfirmed();
      case 'seated':
        return renderSeated();
      case 'expired':
        return renderExpired();
      default:
        return null;
    }
  };

  const renderAssignedTableSpotlight = () => {
    if (!assignedTableMeta || !['called', 'confirmed', 'seated'].includes(customer.status)) {
      return null;
    }

    const statusCopy = {
      called: {
        eyebrow: 'Assigned table',
        description: 'Go straight to this table reference and tap "I\'m Here" when you arrive.',
      },
      confirmed: {
        eyebrow: 'Table on hold',
        description: 'Show this table code to the host if they ask where you were assigned.',
      },
      seated: {
        eyebrow: 'Seated at',
        description: 'This is your table reference for the rest of the meal.',
      },
    }[customer.status as 'called' | 'confirmed' | 'seated'];

    return (
      <div className="mb-5 overflow-hidden rounded-3xl border border-cyan-400/20 bg-gradient-to-br from-cyan-500/20 via-indigo-500/15 to-slate-900 p-4 shadow-2xl shadow-cyan-950/20">
        <p className="text-center text-[11px] font-semibold uppercase tracking-[0.24em] text-cyan-100/80">
          {statusCopy.eyebrow}
        </p>
        <div className="mt-3 rounded-2xl border border-white/10 bg-slate-950/55 px-4 py-5 text-center">
          <p className="text-xs uppercase tracking-[0.18em] text-slate-500">Table number</p>
          <p className="mt-3 font-mono text-5xl font-black tracking-[0.26em] text-white">
            {assignedTableMeta.label}
          </p>
          {assignedTableMeta.subtitle && (
            <p className="mt-2 text-xs text-slate-400">{assignedTableMeta.subtitle}</p>
          )}
        </div>
        <p className="mt-3 text-center text-sm text-cyan-50/90">{statusCopy.description}</p>
      </div>
    );
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-start bg-slate-950 px-4 pb-6 pt-8 sm:justify-center sm:p-4">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute left-1/2 top-1/3 h-96 w-96 -translate-x-1/2 rounded-full bg-indigo-900/20 blur-3xl" />
      </div>

      <div className="relative w-full max-w-sm animate-slide-up">
        <div className="mb-6 flex items-center justify-between">
          <button
            id="leaveQueueBtn"
            onClick={() => {
              void runAction(onLeave);
            }}
            className="flex items-center gap-1.5 text-sm text-slate-400 transition-colors hover:text-white"
          >
            <ChevronLeft className="h-4 w-4" />
            {leaveLabel}
          </button>
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-indigo-600">
              <UtensilsCrossed className="h-3.5 w-3.5 text-white" />
            </div>
            <span className="text-sm font-semibold text-white">{storeName}</span>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-700/50 bg-slate-900/80 p-5 shadow-2xl backdrop-blur-xl">
          {syncMode === 'remote' && syncStatus !== 'connected' && (
            <div className="mb-4 rounded-xl border border-sky-500/20 bg-sky-500/10 px-3 py-2 text-xs text-sky-200">
              {SYNC_STATUS_COPY[syncStatus] ?? 'Updating live queue status.'}
            </div>
          )}
          {actionError && (
            <div className="mb-4 rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              {actionError}
            </div>
          )}
          {pushSyncIssueCopy && (
            <div className="mb-4 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
              {pushSyncIssueCopy}
            </div>
          )}
          {renderAssignedTableSpotlight()}
          {renderContent()}
        </div>

        {customer.status === 'waiting' && (
          <p className="mt-4 text-center text-xs text-slate-600">
            Auto-refreshes in real time - no need to reload
          </p>
        )}
      </div>
    </div>
  );
}
