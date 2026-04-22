import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Armchair,
  Bell,
  CheckCircle2,
  Clock,
  LayoutGrid,
  ListOrdered,
  LogOut,
  MoreHorizontal,
  QrCode,
  RefreshCw,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Smartphone,
  Sparkles,
  UtensilsCrossed,
  Wifi,
} from 'lucide-react';
import { useQueue } from '../../context/useQueue';
import { type MerchantDashboardTab } from '../../utils/portal';
import CustomerQueue from './CustomerQueue';
import CustomerQrModal from './CustomerQrModal';
import ConfirmDialog from './ConfirmDialog';
import NotificationLogs from './NotificationLogs';
import RecentActivity from './RecentActivity';
import StoreControlCenterModal from './StoreControlCenterModal';
import TableGrid from './TableGrid';

interface DashboardProps {
  activeTab: MerchantDashboardTab;
  onTabChange: (tab: MerchantDashboardTab) => void;
  onLogout: () => Promise<void> | void;
  onClearQueue: () => Promise<void> | void;
  onReconfigureTables: () => Promise<void> | void;
}

const SYNC_STATUS_STYLES = {
  connected: {
    label: 'Connected',
    classes: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  },
  syncing: {
    label: 'Syncing',
    classes: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  },
  offline: {
    label: 'Offline',
    classes: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  },
  error: {
    label: 'Action Failed',
    classes: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
  },
  'conflict-refreshed': {
    label: 'Refreshed',
    classes: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-300',
  },
};

function readBillingBannerFromLocation(): string {
  if (typeof window === 'undefined') {
    return '';
  }

  const billingState = new URL(window.location.href).searchParams.get('billing');
  if (billingState === 'success') {
    return 'Stripe checkout completed. Billing status will refresh shortly.';
  }
  if (billingState === 'portal') {
    return 'Returned from the Stripe billing portal.';
  }
  if (billingState === 'cancel') {
    return 'Stripe checkout was cancelled before payment was completed.';
  }

  return '';
}

export default function Dashboard({
  activeTab,
  onTabChange,
  onLogout,
  onClearQueue,
  onReconfigureTables,
}: DashboardProps) {
  const {
    auth,
    autoMode,
    customers,
    dismissProvisioning,
    merchantProfile,
    openBillingPortal,
    refreshMerchantProfile,
    recentProvisioning,
    sendTestNotificationEmail,
    setAutoMode,
    startSubscriptionCheckout,
    syncMode,
    syncStatus,
    tables,
    updateMerchantProfile,
    updateMerchantPassword,
  } = useQueue();
  const [actionError, setActionError] = useState('');
  const [isCustomerQrOpen, setIsCustomerQrOpen] = useState(false);
  const [isStoreControlOpen, setIsStoreControlOpen] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showLogsPanel, setShowLogsPanel] = useState(false);
  const [showActivityPanel, setShowActivityPanel] = useState(false);
  const [showActivitySummary, setShowActivitySummary] = useState(false);
  const [showMoreActions, setShowMoreActions] = useState(false);
  const [billingBanner] = useState(() => readBillingBannerFromLocation());
  const showRemotePanels = syncMode === 'remote';
  const isLogsHistoryVisible = showRemotePanels && (showLogsPanel || activeTab === 'logs');
  const isActivityHistoryVisible =
    showRemotePanels && (showActivityPanel || activeTab === 'activity');

  useEffect(() => {
    if (!showRemotePanels && (activeTab === 'logs' || activeTab === 'activity')) {
      onTabChange('queue');
    }
  }, [activeTab, onTabChange, showRemotePanels]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const currentUrl = new URL(window.location.href);
    const billingState = currentUrl.searchParams.get('billing');

    if (!billingState) {
      return;
    }

    if (billingState === 'success' || billingState === 'portal') {
      void refreshMerchantProfile();
    }

    currentUrl.searchParams.delete('billing');
    window.history.replaceState({}, '', currentUrl.toString());
  }, [refreshMerchantProfile]);

  // ---------- Stats ----------
  const stats = useMemo(() => {
    const waiting = customers.filter(c => c.status === 'waiting').length;
    const called = customers.filter(c => c.status === 'called').length;
    const confirmed = customers.filter(c => c.status === 'confirmed').length;
    const seated = customers.filter(c => c.status === 'seated' && Boolean(c.assignedTableId)).length;
    const availableTables = tables.filter(t => t.status === 'available').length;
    const total = customers.length;
    return { waiting, called, confirmed, seated, availableTables, total };
  }, [customers, tables]);

  const syncBadge = SYNC_STATUS_STYLES[syncStatus];

  const runAction = async (action: () => Promise<void> | void) => {
    setActionError('');
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to update the dashboard right now.');
    }
  };

  const handleHideLogsPanel = () => {
    setShowLogsPanel(false);
    if (activeTab === 'logs') {
      onTabChange('queue');
    }
  };

  const handleHideActivityPanel = () => {
    setShowActivityPanel(false);
    if (activeTab === 'activity') {
      onTabChange('queue');
    }
  };

  const handleOpenActivityHistory = () => {
    setShowActivityPanel(true);
    onTabChange('activity');
  };

  // Which tabs to show on tablet
  const compactTabs = [
    { key: 'queue' as MerchantDashboardTab, label: 'Queue', icon: <ListOrdered className="h-3.5 w-3.5" /> },
    { key: 'tables' as MerchantDashboardTab, label: 'Tables', icon: <LayoutGrid className="h-3.5 w-3.5" /> },
    ...(showRemotePanels && activeTab === 'logs'
      ? [{ key: 'logs' as MerchantDashboardTab, label: 'Logs', icon: <Bell className="h-3.5 w-3.5" /> }]
      : []),
    ...(showRemotePanels && activeTab === 'activity'
      ? [{ key: 'activity' as MerchantDashboardTab, label: 'Activity', icon: <Clock className="h-3.5 w-3.5" /> }]
      : []),
  ];

  // Desktop grid columns
  const visibleDesktopRemotePanels =
    Number(isLogsHistoryVisible) + Number(isActivityHistoryVisible);
  const desktopGridColumns =
    visibleDesktopRemotePanels === 0
      ? '2xl:grid-cols-[minmax(300px,0.75fr)_minmax(0,1.5fr)]'
      : visibleDesktopRemotePanels === 1
        ? '2xl:grid-cols-[minmax(280px,0.7fr)_minmax(0,1.2fr)_minmax(240px,0.65fr)]'
        : '2xl:grid-cols-4';

  return (
    <div className="flex min-h-screen min-w-0 flex-col bg-slate-950">
      {/* ── Compact Header ── */}
      <header className="border-b border-slate-800 bg-slate-900/80 px-3 py-2 backdrop-blur sm:px-4">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600">
              <UtensilsCrossed className="h-3.5 w-3.5 text-white" />
            </div>
            <div className="min-w-0">
              <p className="max-w-[9rem] truncate text-xs font-bold leading-tight text-white sm:max-w-xs">
                {auth.storeName}
              </p>
              <div className="mt-0.5 flex max-w-[12rem] flex-wrap items-center gap-1 sm:max-w-none sm:gap-1.5">
                <span className="inline-flex items-center gap-1 rounded-full bg-slate-800 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                  {syncMode === 'remote' ? (
                    <Wifi className="h-2.5 w-2.5 text-emerald-400" />
                  ) : (
                    <Smartphone className="h-2.5 w-2.5 text-indigo-300" />
                  )}
                  {syncMode === 'remote' ? 'Remote' : 'Local'}
                </span>
                {syncMode === 'remote' && (
                  <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${syncBadge.classes}`}>
                    <RefreshCw className={`h-2.5 w-2.5 ${syncStatus === 'syncing' ? 'animate-spin' : ''}`} />
                    {syncBadge.label}
                  </span>
                )}
                {autoMode && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-cyan-500/20 bg-cyan-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-cyan-200">
                    <Sparkles className="h-2.5 w-2.5" />
                    Auto
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {/* Inline stats bar */}
            <div className="hidden items-center gap-3 rounded-lg border border-slate-700/50 bg-slate-800/60 px-3 py-1.5 sm:flex">
              <span className="flex items-center gap-1 text-[10px] font-semibold text-slate-300">
                <Clock className="h-3 w-3 text-slate-400" />
                {stats.waiting}
              </span>
              <span className="flex items-center gap-1 text-[10px] font-semibold text-amber-400">
                <RefreshCw className="h-3 w-3" />
                {stats.called}
              </span>
              <span className="flex items-center gap-1 text-[10px] font-semibold text-emerald-400">
                <CheckCircle2 className="h-3 w-3" />
                {stats.confirmed}
              </span>
              <span className="flex items-center gap-1 text-[10px] font-semibold text-blue-400">
                <Armchair className="h-3 w-3" />
                {stats.seated}
              </span>
              <span className="text-slate-600">|</span>
              <span className="flex items-center gap-1 text-[10px] font-semibold text-indigo-400">
                <LayoutGrid className="h-3 w-3" />
                {stats.availableTables}/{tables.length}
              </span>
              <span className="flex items-center gap-1 text-[10px] font-semibold text-purple-400">
                <Sparkles className="h-3 w-3" />
                {stats.total}
              </span>
            </div>

            {/* Mobile stats – minimal */}
            <div className="flex items-center gap-2 rounded-lg border border-slate-700/50 bg-slate-800/60 px-2 py-1 sm:hidden">
              <span className="text-[10px] font-bold text-slate-300">{stats.waiting}w</span>
              <span className="text-[10px] font-bold text-amber-400">{stats.called}c</span>
              <span className="text-[10px] font-bold text-indigo-400">{stats.availableTables}t</span>
            </div>

            {/* Quick actions */}
            {syncMode === 'remote' && (
              <button
                id="customerQrBtn"
                onClick={() => setIsCustomerQrOpen(true)}
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-emerald-500/20 bg-emerald-500/10 text-emerald-300 transition-colors active:bg-emerald-500/20 sm:h-8 sm:w-8"
                title="Customer QR"
              >
                <QrCode className="h-3.5 w-3.5" />
              </button>
            )}

            <button
              id="moreActionsBtn"
              onClick={() => setShowMoreActions(prev => !prev)}
              className={`flex h-9 w-9 items-center justify-center rounded-lg border transition-colors active:bg-slate-700 sm:h-8 sm:w-8 ${
                showMoreActions
                  ? 'border-indigo-500/30 bg-indigo-500/15 text-indigo-300'
                  : 'border-slate-700 bg-slate-800 text-slate-300'
              }`}
              title="More actions"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>

            <button
              id="logoutBtn"
              onClick={() => { void onLogout(); }}
              className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-400 transition-colors active:bg-slate-800 active:text-white sm:h-8 sm:w-8"
              title="Logout"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* More actions dropdown */}
        {showMoreActions && (
          <div className="mx-auto mt-2 grid max-w-7xl grid-cols-2 gap-1.5 border-t border-slate-800 pt-2 animate-fade-in sm:flex sm:flex-wrap">
            <button
              id="toggleAutoModeBtn"
              onClick={() => { void runAction(() => setAutoMode(!autoMode)); }}
              className={`inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition-colors active:scale-[0.99] sm:min-h-0 sm:text-[10px] ${
                autoMode
                  ? 'border-cyan-500/30 bg-cyan-500/15 text-cyan-200'
                  : 'border-slate-700 bg-slate-800 text-slate-200'
              }`}
            >
              <Sparkles className="h-3 w-3" />
              Auto Mode {autoMode ? 'On' : 'Off'}
            </button>
            <button
              id="reconfigureTablesBtn"
              onClick={() => { setShowMoreActions(false); void runAction(onReconfigureTables); }}
              className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-[11px] font-semibold text-slate-200 transition-colors active:bg-slate-700 sm:min-h-0 sm:text-[10px]"
            >
              <Settings2 className="h-3 w-3" />
              Reconfigure Tables
            </button>
            <button
              id="clearQueueBtn"
              onClick={() => { setShowMoreActions(false); setShowClearConfirm(true); }}
              className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-rose-500/20 bg-rose-500/10 px-2.5 py-1.5 text-[11px] font-semibold text-rose-200 transition-colors active:bg-rose-500/20 sm:min-h-0 sm:text-[10px]"
            >
              <RotateCcw className="h-3 w-3" />
              Clear Queue
            </button>
            {syncMode === 'remote' && (
              <>
                <button
                  id="openStoreControlBtn"
                  onClick={() => { setShowMoreActions(false); setIsStoreControlOpen(true); }}
                  className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-[11px] font-semibold text-slate-200 transition-colors active:bg-slate-700 sm:min-h-0 sm:text-[10px]"
                >
                  <ShieldCheck className="h-3 w-3" />
                  Store Control
                </button>
                <button
                  id="compactLogsBtn"
                  onClick={() => {
                    setShowLogsPanel(true);
                    onTabChange('logs');
                    setShowMoreActions(false);
                  }}
                  className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-[11px] font-semibold text-slate-200 transition-colors active:bg-slate-700 sm:min-h-0 sm:text-[10px]"
                >
                  <Bell className="h-3 w-3" />
                  Logs
                </button>
                <button
                  id="compactActivityBtn"
                  onClick={() => {
                    handleOpenActivityHistory();
                    setShowMoreActions(false);
                  }}
                  className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-[11px] font-semibold text-slate-200 transition-colors active:bg-slate-700 sm:min-h-0 sm:text-[10px]"
                >
                  <Clock className="h-3 w-3" />
                  Activity
                </button>
              </>
            )}
          </div>
        )}
      </header>

      {/* ── Banners (compact) ── */}
      <div className="px-3 sm:px-4">
        <div className="mx-auto max-w-7xl">
          {syncMode === 'remote' && syncStatus !== 'connected' && syncStatus !== 'syncing' && (
            <div className="mt-2 flex items-start gap-2 rounded-lg border border-sky-500/20 bg-sky-500/10 px-3 py-1.5 text-[11px] text-sky-200">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              <p>
                {syncStatus === 'offline' && 'Queue server is offline. You may be seeing cached data.'}
                {syncStatus === 'error' && 'The last queue action failed. Retry once the server is reachable.'}
                {syncStatus === 'conflict-refreshed' && 'Another device changed the queue. Dashboard refreshed.'}
              </p>
            </div>
          )}

          {actionError && (
            <div className="mt-2 rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-1.5 text-[11px] text-rose-200">
              {actionError}
            </div>
          )}

          {autoMode && (
            <div className="mt-2 rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-3 py-1.5 text-[11px] text-cyan-100">
              Auto Mode is on. Open tables will automatically call the next suitable waiting customer.
            </div>
          )}

          {billingBanner && (
            <div className="mt-2 rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-3 py-1.5 text-[11px] text-cyan-100">
              {billingBanner}
            </div>
          )}

          {recentProvisioning && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2">
              <div>
                <p className="text-[11px] font-semibold text-emerald-100">
                  Store provisioned — ID <span className="font-bold">{recentProvisioning.storeId}</span>, password <span className="font-bold">{recentProvisioning.temporaryPassword}</span>
                </p>
              </div>
              <button
                id="dismissProvisioningBtn"
                onClick={dismissProvisioning}
                className="rounded-lg border border-emerald-400/20 bg-emerald-400/10 px-2 py-1 text-[10px] font-semibold text-emerald-50 transition-colors active:bg-emerald-400/20"
              >
                Dismiss
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Main Content ── */}
      <main className="min-w-0 flex-1 overflow-auto px-3 pb-4 pt-2 sm:px-4">
        <div className="mx-auto min-w-0 max-w-7xl">
          {/* Tab bar – visible on tablet */}
          <div className="mb-2 flex gap-1 overflow-x-auto rounded-lg border border-slate-800 bg-slate-900/60 p-0.5 2xl:hidden">
            {compactTabs.map(tab => (
              <button
                key={tab.key}
                id={`tab-${tab.key}`}
                onClick={() => onTabChange(tab.key)}
                className={`flex min-w-[5.5rem] flex-1 items-center justify-center gap-1 rounded-md px-2 py-2 text-[11px] font-semibold transition-all sm:min-w-0 sm:py-1.5 ${
                  activeTab === tab.key
                    ? 'bg-indigo-600 text-white shadow-md'
                    : 'text-slate-400 active:bg-slate-800 active:text-white'
                }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>

          {/* ── Split pane layout ── */}
          <div className={`grid h-full min-w-0 grid-cols-1 gap-2 ${showRemotePanels ? desktopGridColumns : '2xl:grid-cols-[minmax(300px,0.75fr)_minmax(0,1.5fr)]'}`}>
            {/* Queue panel + summary activity */}
            <div className={`flex min-h-0 min-w-0 flex-col gap-2 ${activeTab !== 'queue' ? 'hidden 2xl:flex' : ''}`}>
              <div className="flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border border-slate-800 bg-slate-900/60">
                <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2">
                  <div className="flex h-6 w-6 items-center justify-center rounded-md bg-indigo-500/20">
                    <ListOrdered className="h-3.5 w-3.5 text-indigo-400" />
                  </div>
                  <h2 className="text-xs font-semibold text-white">Queue</h2>
                  <span className="ml-auto rounded-full bg-slate-800 px-1.5 py-0.5 text-[10px] font-bold text-slate-300">
                    {customers.filter(c => c.status !== 'seated').length}
                  </span>
                </div>
                <div className="flex-1 overflow-y-auto p-2">
                  <CustomerQueue />
                </div>
              </div>

              {showRemotePanels && !isActivityHistoryVisible && (
                showActivitySummary ? (
                  <div className="rounded-xl border border-slate-800 bg-slate-900/60">
                    <div className="p-3">
                      <RecentActivity
                        mode="summary"
                        onViewAll={handleOpenActivityHistory}
                        onHide={() => setShowActivitySummary(false)}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-white">Recent Activity</p>
                        <p className="mt-0.5 text-xs text-slate-500">
                          Hidden by default so queue and tables stay clear during service.
                        </p>
                      </div>
                      <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
                        <button
                          id="showRecentActivityBtn"
                          type="button"
                          onClick={() => setShowActivitySummary(true)}
                          className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs font-semibold text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-700 sm:min-h-0"
                        >
                          Show
                        </button>
                        <button
                          id="viewAllActivityCollapsedBtn"
                          type="button"
                          onClick={handleOpenActivityHistory}
                          className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-slate-400 transition-colors hover:bg-slate-800 hover:text-white sm:min-h-0"
                        >
                          View all
                        </button>
                      </div>
                    </div>
                  </div>
                )
              )}
            </div>

            {/* Tables panel */}
            <div className={`flex min-w-0 flex-col rounded-xl border border-slate-800 bg-slate-900/60 ${activeTab !== 'tables' ? 'hidden 2xl:flex' : ''}`}>
              <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2">
                <div className="flex h-6 w-6 items-center justify-center rounded-md bg-purple-500/20">
                  <LayoutGrid className="h-3.5 w-3.5 text-purple-400" />
                </div>
                <h2 className="text-xs font-semibold text-white">Tables</h2>
                <div className="ml-auto flex items-center gap-1.5">
                  <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-bold text-emerald-200">
                    {stats.availableTables} open
                  </span>
                  <span className="rounded-full bg-slate-800 px-1.5 py-0.5 text-[10px] font-bold text-slate-300">
                    {tables.length} total
                  </span>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-2">
                <TableGrid />
              </div>
            </div>

            {isLogsHistoryVisible && (
              <div className={`flex min-w-0 flex-col rounded-xl border border-slate-800 bg-slate-900/60 ${activeTab !== 'logs' ? 'hidden 2xl:flex' : ''}`}>
                <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2">
                  <div className="flex h-6 w-6 items-center justify-center rounded-md bg-amber-500/20">
                    <Bell className="h-3.5 w-3.5 text-amber-400" />
                  </div>
                  <h2 className="text-xs font-semibold text-white">Notification Logs</h2>
                  <button
                    id="hideLogsPanelBtn"
                    onClick={handleHideLogsPanel}
                    className="ml-auto hidden rounded-md px-2 py-0.5 text-[10px] font-semibold text-slate-400 transition-colors active:bg-slate-800 active:text-white 2xl:inline-flex"
                  >
                    Hide
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto p-2">
                  <NotificationLogs />
                </div>
              </div>
            )}

            {isActivityHistoryVisible && (
              <div className={`flex min-w-0 flex-col rounded-xl border border-slate-800 bg-slate-900/60 ${activeTab !== 'activity' ? 'hidden 2xl:flex' : ''}`}>
                <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2">
                  <div className="flex h-6 w-6 items-center justify-center rounded-md bg-sky-500/20">
                    <Clock className="h-3.5 w-3.5 text-sky-400" />
                  </div>
                  <h2 className="text-xs font-semibold text-white">Activity History</h2>
                  <button
                    id="hideActivityPanelBtn"
                    onClick={handleHideActivityPanel}
                    className="ml-auto hidden rounded-md px-2 py-0.5 text-[10px] font-semibold text-slate-400 transition-colors active:bg-slate-800 active:text-white 2xl:inline-flex"
                  >
                    Hide
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto p-2">
                  <RecentActivity mode="history" />
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Confirm: Clear Queue */}
      <ConfirmDialog
        isOpen={showClearConfirm}
        title="Clear Entire Queue"
        description="This will remove all waiting, called, and confirmed customers from the queue. Seated customers will also be cleared. This cannot be undone."
        confirmLabel="Clear All"
        variant="danger"
        onConfirm={() => {
          setShowClearConfirm(false);
          void runAction(onClearQueue);
        }}
        onCancel={() => setShowClearConfirm(false)}
      />

      {syncMode === 'remote' && isCustomerQrOpen && (
        <CustomerQrModal
          storeId={auth.storeId}
          storeName={auth.storeName}
          onClose={() => {
            setIsCustomerQrOpen(false);
          }}
        />
      )}

      {syncMode === 'remote' && merchantProfile && (
        <StoreControlCenterModal
          isOpen={isStoreControlOpen}
          profile={merchantProfile}
          provisioning={recentProvisioning}
          onClose={() => {
            setIsStoreControlOpen(false);
          }}
          onOpenQr={() => {
            setIsStoreControlOpen(false);
            setIsCustomerQrOpen(true);
          }}
          onSave={async input => {
            await updateMerchantProfile(input);
          }}
          onChangePassword={async input => {
            await updateMerchantPassword(input);
          }}
          onStartSubscription={async planCode => {
            const url = await startSubscriptionCheckout(planCode);
            if (typeof window !== 'undefined') {
              window.location.assign(url);
            }
          }}
          onOpenBillingPortal={async () => {
            const url = await openBillingPortal();
            if (typeof window !== 'undefined') {
              window.location.assign(url);
            }
          }}
          onSendTestNotification={async recipient => {
            await sendTestNotificationEmail(recipient);
          }}
        />
      )}
    </div>
  );
}
