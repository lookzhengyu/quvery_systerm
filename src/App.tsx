import { useEffect, useState } from 'react';
import { QueueProvider } from './context/QueueContext';
import {
  clearActiveCustomerSession,
  CUSTOMER_SESSION_INVALIDATED_EVENT,
  readActiveCustomerId,
  writeActiveCustomerId,
} from './context/storage';
import { useQueue } from './context/useQueue';
import JoinForm from './components/customer/JoinForm';
import StatusCard from './components/customer/StatusCard';
import Dashboard from './components/merchant/Dashboard';
import Login from './components/merchant/Login';
import TableConfig from './components/merchant/TableConfig';
import {
  buildMerchantDashboardUrl,
  resolveInitialMerchantTab,
  resolveInitialPortal,
  resolveInitialRemoteStoreId,
  type MerchantDashboardTab,
  type Portal,
} from './utils/portal';

function MerchantPortal() {
  const { auth, customers, isTablesConfigured, logout, resetQueue, tables } = useQueue();
  const [isReconfiguringTables, setIsReconfiguringTables] = useState(false);
  const [dashboardTab, setDashboardTab] = useState<MerchantDashboardTab>(() => resolveInitialMerchantTab());

  useEffect(() => {
    const syncFromLocation = () => {
      setDashboardTab(resolveInitialMerchantTab());
    };

    window.addEventListener('popstate', syncFromLocation);

    return () => {
      window.removeEventListener('popstate', syncFromLocation);
    };
  }, []);

  const navigateMerchantTab = (tab: MerchantDashboardTab, replace = false) => {
    if (typeof window === 'undefined') {
      return;
    }

    const nextUrl = buildMerchantDashboardUrl(tab);

    if (replace) {
      window.history.replaceState({}, '', nextUrl);
    } else if (window.location.href !== nextUrl) {
      window.history.pushState({}, '', nextUrl);
    }

    setDashboardTab(tab);
  };

  if (!auth.isLoggedIn) {
    return <Login onSuccess={() => undefined} />;
  }

  if (!isTablesConfigured || isReconfiguringTables) {
    return (
      <TableConfig
        existingTables={tables}
        warningText={
          isTablesConfigured
            ? 'Saving a new table layout clears the current queue and releases all held tables.'
            : undefined
        }
        beforeSave={
          isTablesConfigured
            ? async () => {
                await resetQueue();
              }
            : undefined
        }
        onCancel={
          isTablesConfigured
            ? () => {
                setIsReconfiguringTables(false);
              }
            : undefined
        }
        onComplete={() => {
          setIsReconfiguringTables(false);
          navigateMerchantTab('tables');
        }}
      />
    );
  }

  return (
    <Dashboard
      activeTab={dashboardTab}
      onTabChange={tab => navigateMerchantTab(tab)}
      onLogout={logout}
      onClearQueue={async () => {
        await resetQueue();
      }}
      onReconfigureTables={async () => {
        if (
          customers.length > 0 &&
          typeof window !== 'undefined' &&
          !window.confirm('Reconfiguring tables will clear the current queue. Continue?')
        ) {
          return;
        }

        setIsReconfiguringTables(true);
      }}
    />
  );
}

function LiveCustomerPortal() {
  const { auth, syncMode } = useQueue();
  const customerStoreScope = syncMode === 'remote' ? auth.storeId || resolveInitialRemoteStoreId() : undefined;

  return (
    <LiveCustomerPortalSession
      key={`${syncMode}:${customerStoreScope ?? 'local'}`}
      customerStoreScope={customerStoreScope}
      syncMode={syncMode}
    />
  );
}

function LiveCustomerPortalSession({
  customerStoreScope,
  syncMode,
}: {
  customerStoreScope?: string;
  syncMode: 'local' | 'remote';
}) {
  const { customers, leaveQueue, validateCustomerSession } = useQueue();
  const [activeCustomerId, setActiveCustomerId] = useState<string | null>(() =>
    readActiveCustomerId(customerStoreScope)
  );
  const [validatedCustomerId, setValidatedCustomerId] = useState<string | null>(null);

  const activeCustomer = activeCustomerId
    ? customers.find(customer => customer.id === activeCustomerId) ?? null
    : null;
  const shouldValidateCustomerSession =
    syncMode === 'remote' && Boolean(customerStoreScope) && Boolean(activeCustomerId);
  const isValidatingCustomerSession =
    shouldValidateCustomerSession && validatedCustomerId !== activeCustomerId;

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleSessionInvalidated = (event: Event) => {
      const detail =
        event instanceof CustomEvent ? (event.detail as { storeId?: string | null } | null) : null;
      const invalidatedStoreId =
        typeof detail?.storeId === 'string' ? detail.storeId.toUpperCase() : null;
      const currentStoreId = customerStoreScope?.toUpperCase() ?? null;

      if (invalidatedStoreId && currentStoreId && invalidatedStoreId !== currentStoreId) {
        return;
      }

      setActiveCustomerId(null);
      setValidatedCustomerId(null);
    };

    window.addEventListener(
      CUSTOMER_SESSION_INVALIDATED_EVENT,
      handleSessionInvalidated as EventListener
    );

    return () => {
      window.removeEventListener(
        CUSTOMER_SESSION_INVALIDATED_EVENT,
        handleSessionInvalidated as EventListener
      );
    };
  }, [customerStoreScope]);

  useEffect(() => {
    if (!shouldValidateCustomerSession || !activeCustomerId) {
      return;
    }

    let cancelled = false;

    void validateCustomerSession(activeCustomerId)
      .then(valid => {
        if (cancelled) {
          return;
        }

        if (!valid) {
          clearActiveCustomerSession(customerStoreScope);
          setActiveCustomerId(null);
        }

        setValidatedCustomerId(activeCustomerId);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        clearActiveCustomerSession(customerStoreScope);
        setActiveCustomerId(null);
        setValidatedCustomerId(activeCustomerId);
      });

    return () => {
      cancelled = true;
    };
  }, [activeCustomerId, customerStoreScope, shouldValidateCustomerSession, validateCustomerSession]);

  useEffect(() => {
    if (activeCustomer) {
      writeActiveCustomerId(activeCustomer.id, customerStoreScope);
      return;
    }

    if (activeCustomerId) {
      return;
    }

    clearActiveCustomerSession(customerStoreScope);
  }, [activeCustomer, activeCustomerId, customerStoreScope]);

  if (syncMode === 'remote' && activeCustomerId && (isValidatingCustomerSession || !activeCustomer)) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-slate-950 px-4 text-center">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/80 px-5 py-4">
          <p className="text-sm font-semibold text-white">Restoring your queue session…</p>
          <p className="mt-1 text-xs text-slate-400">
            Checking whether this browser still has a valid queue session.
          </p>
        </div>
      </div>
    );
  }

  if (activeCustomer) {
    return (
      <StatusCard
        customer={activeCustomer}
        onLeave={async () => {
          if (activeCustomer.status !== 'seated') {
            await leaveQueue(activeCustomer.id);
          }
          setActiveCustomerId(null);
        }}
        onRejoin={async () => {
          await leaveQueue(activeCustomer.id);
          setActiveCustomerId(null);
        }}
      />
    );
  }

  return <JoinForm onJoined={customer => setActiveCustomerId(customer.id)} />;
}

function AppContent() {
  const [portal, setPortal] = useState<Portal>(() => resolveInitialPortal());

  useEffect(() => {
    const syncFromLocation = () => {
      setPortal(resolveInitialPortal());
    };

    window.addEventListener('popstate', syncFromLocation);

    return () => {
      window.removeEventListener('popstate', syncFromLocation);
    };
  }, []);

  return (
    <div className="relative">
      <div key={portal} className="animate-fade-in">
        {portal === 'merchant' ? <MerchantPortal /> : <LiveCustomerPortal />}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <QueueProvider>
      <AppContent />
    </QueueProvider>
  );
}
