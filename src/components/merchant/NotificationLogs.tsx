import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  Bell,
  CheckCircle2,
  Clock,
  Mail,
  RefreshCw,
  Smartphone,
  XCircle,
} from 'lucide-react';
import { useQueue } from '../../context/useQueue';
import type { NotificationLog, NotificationLogStatus } from '../../types';

const STATUS_BADGE: Record<NotificationLogStatus, { label: string; classes: string; icon: typeof CheckCircle2 }> = {
  pending: {
    label: 'Pending',
    classes: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    icon: Clock,
  },
  sent: {
    label: 'Sent',
    classes: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    icon: CheckCircle2,
  },
  skipped: {
    label: 'Skipped',
    classes: 'border-slate-500/30 bg-slate-500/10 text-slate-400',
    icon: AlertCircle,
  },
  failed: {
    label: 'Failed',
    classes: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
    icon: XCircle,
  },
};

function formatTimestamp(iso: string): string {
  try {
    const date = new Date(iso);
    return date.toLocaleString('en-US', {
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

export default function NotificationLogs() {
  const { fetchNotificationLogs, syncMode } = useQueue();
  const [logs, setLogs] = useState<NotificationLog[]>([]);
  const [loading, setLoading] = useState(true);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchNotificationLogs(100);
      setLogs(result);
    } finally {
      setLoading(false);
    }
  }, [fetchNotificationLogs]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  if (syncMode === 'local') {
    return (
      <div className="flex h-full flex-col items-center justify-center py-12 text-center">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-800">
          <Mail className="h-6 w-6 text-slate-600" />
        </div>
        <p className="text-sm text-slate-400">Notification logs are only available in remote mode.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="h-5 w-5 animate-spin text-slate-400" />
      </div>
    );
  }

  if (logs.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center py-12 text-center">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-800">
          <Bell className="h-6 w-6 text-slate-600" />
        </div>
        <p className="text-sm text-slate-400">No notification logs yet.</p>
        <p className="mt-1 text-xs text-slate-600">Logs will appear here when customers are called.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs text-slate-500">{logs.length} log{logs.length !== 1 ? 's' : ''}</span>
        <button
          id="refreshNotificationLogs"
          onClick={() => { void loadLogs(); }}
          className="flex min-h-9 items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-slate-400 transition-colors hover:bg-slate-800 hover:text-white sm:min-h-0"
        >
          <RefreshCw className="h-3 w-3" />
          Refresh
        </button>
      </div>
      {logs.map(log => {
        const badge = STATUS_BADGE[log.status] ?? STATUS_BADGE.pending;
        const BadgeIcon = badge.icon;
        const ChannelIcon = log.channel === 'push' ? Smartphone : Mail;

        return (
          <div
            key={log.id}
            className="min-w-0 rounded-xl border border-slate-700/50 bg-slate-800/50 p-3.5 transition-all duration-200 hover:border-slate-600/50"
          >
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${badge.classes}`}>
                <BadgeIcon className="h-3 w-3" />
                {badge.label}
              </span>
              <span className="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">
                {log.eventType}
              </span>
              <span className="w-full text-xs text-slate-500 sm:ml-auto sm:w-auto">
                {formatTimestamp(log.createdAt)}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 sm:gap-3">
              <span className="flex min-w-0 items-center gap-1 break-all">
                <ChannelIcon className="h-3 w-3" />
                {log.recipient}
              </span>
              {log.channel && (
                <span className="text-slate-600">via {log.channel}</span>
              )}
            </div>
            {log.errorMessage && log.errorMessage.length > 0 && (
              <div className="mt-2 rounded-lg border border-rose-500/20 bg-rose-500/5 px-3 py-1.5 text-xs text-rose-300">
                {log.errorMessage}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
