import { useEffect, useState, type FormEvent } from 'react';
import { AlertCircle, Bell, ChevronRight, Clock, Mail, Phone, Users, UtensilsCrossed } from 'lucide-react';
import { useQueue } from '../../context/useQueue';
import type { Customer, SyncStatus } from '../../types';
import {
  getBrowserNotificationPermissionState,
  requestBrowserNotificationPermission,
  syncCustomerPushSubscription,
  type BrowserNotificationPermissionState,
} from '../../utils/pushNotifications';

interface JoinFormProps {
  onJoined: (customer: Customer) => void;
}

const PARTY_SIZES = [1, 2, 3, 4, 5, 6, 7, 8];

const SYNC_STATUS_COPY: Partial<Record<SyncStatus, string>> = {
  syncing: 'Syncing with the live queue server.',
  offline: 'The live queue server is offline. You may see stale data until the connection returns.',
  error: 'The last queue request failed. Please try again.',
  'conflict-refreshed': 'Queue data changed on another device and has been refreshed.',
};

function getNotificationIssueCopy(permission: BrowserNotificationPermissionState): string {
  switch (permission) {
    case 'ios-needs-home-screen':
      return 'On iPhone, open this queue in Safari, tap Share, add it to Home Screen, then open QueueFlow from that icon to enable alerts.';
    case 'missing-vapid-key':
      return 'Push alerts are not configured on this deployment yet. Ask the restaurant to finish web push setup, or keep this page open.';
    case 'insecure-context':
      return 'Open the HTTPS live link to enable phone alerts.';
    case 'unsupported':
      return 'This browser cannot receive background web push alerts. Keep this page open or use email backup.';
    case 'denied':
      return 'Notifications are blocked on this device. Enable them in browser or phone settings to receive call alerts.';
    default:
      return 'Notifications are off on this device. You can still join the queue, but if this page is closed you may miss your call.';
  }
}

export default function JoinForm({ onJoined }: JoinFormProps) {
  const { addCustomer, auth, customers, prepareCustomerEntry, syncMode, syncStatus, tables } = useQueue();
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [partySize, setPartySize] = useState(2);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isRequestingNotification, setIsRequestingNotification] = useState(false);
  const [notificationSkipped, setNotificationSkipped] = useState(false);
  const [notificationPermission, setNotificationPermission] =
    useState<BrowserNotificationPermissionState>(() => getBrowserNotificationPermissionState());

  const queueIsOpen = tables.length > 0;
  const storeName = auth.storeName || 'Restaurant';
  const waitingCount = customers.filter(c => c.status === 'waiting' || c.status === 'called' || c.status === 'confirmed').length;

  useEffect(() => {
    if (syncMode !== 'remote' || !auth.storeId) {
      return;
    }

    void prepareCustomerEntry().catch(() => undefined);
  }, [auth.storeId, prepareCustomerEntry, syncMode]);

  useEffect(() => {
    const refreshPermission = () => {
      const nextPermission = getBrowserNotificationPermissionState();
      setNotificationPermission(nextPermission);
      if (nextPermission === 'granted') {
        setNotificationSkipped(false);
      }
    };

    refreshPermission();
    window.addEventListener('focus', refreshPermission);
    document.addEventListener('visibilitychange', refreshPermission);

    return () => {
      window.removeEventListener('focus', refreshPermission);
      document.removeEventListener('visibilitychange', refreshPermission);
    };
  }, []);

  const handleEnableNotifications = async () => {
    setError('');
    setIsRequestingNotification(true);

    try {
      const nextPermission = await requestBrowserNotificationPermission();
      setNotificationPermission(nextPermission);
      if (nextPermission === 'granted') {
        setNotificationSkipped(false);
      }
    } finally {
      setIsRequestingNotification(false);
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');

    const cleanedPhone = phone.replace(/\D/g, '');
    if (cleanedPhone.length < 8) {
      setError('Please enter a valid phone number with at least 8 digits.');
      return;
    }

    const trimmedEmail = email.trim().toLowerCase();
    if (trimmedEmail.length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setError('Please enter a valid email address or leave it empty.');
      return;
    }

    setIsLoading(true);

    try {
      const result = await addCustomer(cleanedPhone, partySize, trimmedEmail || undefined);
      const customer = result.customer;

      if (!customer) {
        setError('Unable to join the queue right now. Please try again.');
        return;
      }

      onJoined(customer);
      void syncCustomerPushSubscription({
        storeId: auth.storeId,
        customerId: customer.id,
        requestPermission: false,
      }).catch(() => undefined);
    } catch {
      setError('Unable to join the queue right now. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-start bg-gradient-to-b from-slate-50 to-indigo-50 px-4 pb-6 pt-8 sm:justify-center sm:p-4">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -right-20 -top-20 h-72 w-72 rounded-full bg-indigo-100 opacity-60 blur-3xl" />
        <div className="absolute -bottom-20 -left-20 h-64 w-64 rounded-full bg-purple-100 opacity-60 blur-3xl" />
      </div>

      <div className="relative w-full max-w-sm animate-slide-up">
        <div className="mb-8 text-center">
          <div className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 shadow-xl shadow-indigo-200">
            <UtensilsCrossed className="h-8 w-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-slate-800">{storeName}</h1>
          <p className="mt-1 text-sm text-slate-500">
            Join the queue and track your table in real time
          </p>
        </div>

        {/* Live queue preview */}
        {queueIsOpen && (
          <div className="mb-4 flex items-center justify-center gap-4 rounded-2xl border border-indigo-100 bg-white/70 p-3">
            <div className="text-center">
              <p className="text-2xl font-bold text-indigo-600">{waitingCount}</p>
              <p className="text-xs text-slate-500">in queue</p>
            </div>
            <div className="h-8 w-px bg-slate-200" />
            <div className="text-center">
              <p className="text-2xl font-bold text-emerald-600">
                {tables.filter(t => t.status === 'available').length}
              </p>
              <p className="text-xs text-slate-500">tables free</p>
            </div>
            <div className="h-8 w-px bg-slate-200" />
            <div className="text-center">
              <p className="flex items-center justify-center gap-1 text-2xl font-bold text-purple-600">
                <Clock className="h-4 w-4" />
                ~{waitingCount * 4 || '<1'}
              </p>
              <p className="text-xs text-slate-500">min wait</p>
            </div>
          </div>
        )}

        {!queueIsOpen && (
          <div className="mb-4 flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-4">
            <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-500" />
            <p className="text-sm text-amber-700">
              Queue is not open yet. The restaurant has not started the system.
            </p>
          </div>
        )}

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/50">
          {syncMode === 'remote' && syncStatus !== 'connected' && (
            <div className="mb-4 flex items-start gap-2 rounded-xl border border-sky-200 bg-sky-50 p-3">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-sky-500" />
              <p className="text-xs text-sky-700">
                {SYNC_STATUS_COPY[syncStatus] ?? 'Live queue status is being updated.'}
              </p>
            </div>
          )}

          {notificationPermission === 'default' && !notificationSkipped && (
            <div className="mb-4 rounded-xl border border-indigo-200 bg-indigo-50 p-4">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 rounded-lg bg-indigo-100 p-2">
                  <Bell className="h-4 w-4 text-indigo-600" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-slate-800">
                    Tap here to enable call notifications
                  </p>
                  <p className="mt-1 text-xs text-slate-600">
                    Allow notifications so your phone can still alert you when the merchant calls you.
                  </p>
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <button
                      type="button"
                      onClick={() => {
                        void handleEnableNotifications();
                      }}
                      disabled={isRequestingNotification}
                      className="inline-flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition-all hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isRequestingNotification ? (
                        <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                      ) : (
                        <Bell className="h-4 w-4" />
                      )}
                      Enable notifications
                    </button>
                    <button
                      type="button"
                      onClick={() => setNotificationSkipped(true)}
                      className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:border-slate-300 hover:text-slate-800"
                    >
                      Continue without notifications
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {notificationPermission === 'granted' && (
            <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3">
              <p className="text-xs font-medium text-emerald-700">
                Call notifications are enabled on this device.
              </p>
            </div>
          )}

          {((notificationSkipped && notificationPermission === 'default') ||
            notificationPermission === 'denied' ||
            notificationPermission === 'unsupported' ||
            notificationPermission === 'insecure-context' ||
            notificationPermission === 'ios-needs-home-screen' ||
            notificationPermission === 'missing-vapid-key') && (
            <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3">
              <div className="flex items-start gap-3">
                <p className="min-w-0 flex-1 text-xs text-amber-700">
                  {getNotificationIssueCopy(notificationPermission)}
                </p>
                {notificationPermission === 'default' && (
                  <button
                    type="button"
                    onClick={() => {
                      setNotificationSkipped(false);
                      void handleEnableNotifications();
                    }}
                    className="rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-amber-700 transition-colors hover:bg-amber-100"
                  >
                    Enable
                  </button>
                )}
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                Phone Number
              </label>
              <div className="relative">
                <Phone className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  id="customerPhone"
                  type="tel"
                  value={phone}
                  onChange={event => setPhone(event.target.value)}
                  placeholder="+60 12-345 6789"
                  className="w-full rounded-xl border border-slate-200 py-3 pl-10 pr-4 text-sm text-slate-800 placeholder-slate-300 transition-all focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
                  required
                />
              </div>
            </div>

            <div>
              <label className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                <Bell className="h-3 w-3 text-indigo-400" />
                Email for backup alerts
              </label>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  id="customerEmail"
                  type="email"
                  value={email}
                  onChange={event => setEmail(event.target.value)}
                  placeholder="optional@example.com"
                  className="w-full rounded-xl border border-slate-200 py-3 pl-10 pr-4 text-sm text-slate-800 placeholder-slate-300 transition-all focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
                />
              </div>
              <p className="mt-1 text-xs text-slate-400">
                Browser notifications are the main alert. Email only works as a fallback if the restaurant enabled email sending.
              </p>
            </div>

            {syncMode === 'remote' && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                <p className="text-xs text-slate-500">
                  Reopen this queue on the same browser to restore your live ticket securely.
                </p>
              </div>
            )}

            <div>
              <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                <span className="flex items-center gap-1.5">
                  <Users className="h-3.5 w-3.5" />
                  Party Size
                </span>
              </label>
              <div className="grid grid-cols-4 gap-2">
                {PARTY_SIZES.map(size => (
                  <button
                    key={size}
                    id={`party-${size}`}
                    type="button"
                    onClick={() => setPartySize(size)}
                    className={`rounded-xl py-2.5 text-sm font-semibold transition-all duration-150 ${
                      partySize === size
                        ? 'bg-indigo-600 text-white shadow-md shadow-indigo-200'
                        : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                    }`}
                  >
                    {size}
                  </button>
                ))}
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 animate-fade-in">
                <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-rose-500" />
                <p className="text-xs text-rose-600">{error}</p>
              </div>
            )}

            <button
              id="joinQueueBtn"
              type="submit"
              disabled={isLoading || !queueIsOpen}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 py-3.5 text-sm font-semibold text-white shadow-lg shadow-indigo-200 transition-all duration-200 hover:-translate-y-0.5 hover:from-indigo-500 hover:to-purple-500 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isLoading ? (
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
              ) : (
                <>
                  Join Queue
                  <ChevronRight className="h-4 w-4" />
                </>
              )}
            </button>
          </form>
        </div>

        <p className="mt-4 text-center text-xs text-slate-400">
          Allow notifications for the smoothest experience. You can still join without them, but alerts may be missed after the page is closed.
        </p>
      </div>
    </div>
  );
}
