import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { RefreshCw, Smartphone, Wifi } from 'lucide-react';
import type {
  Customer,
  MerchantAuth,
  MerchantPasswordUpdateInput,
  MerchantPlanCode,
  MerchantProfile,
  MerchantProfileUpdateInput,
  MerchantProvisioning,
  MerchantRegistrationInput,
  QueueContextType,
  SyncStatus,
  Table,
} from '../types';
import { calcEstimatedWait } from '../utils/tableMatching';
import { QueueContext } from './queue-context';
import {
  applyAutomaticQueueState,
  addCustomerState,
  addTableState,
  callCustomerState,
  clearQueueState,
  confirmArrivalState,
  createQueueStoreAdapter,
  expireCustomerState,
  markTableAvailableState,
  markTableCleaningState,
  removeCustomerFromState,
  removeTableState,
  requeueCustomerState,
  seatCustomerState,
  setAutoModeState,
  type QueueFetchScope,
} from './store-adapter';
import {
  clearActiveCustomerToken,
  createInitialQueueState,
  type QueueStoreState,
} from './storage';
import {
  resolveInitialPortal,
  resolveInitialRemoteStoreId,
  type Portal,
} from '../utils/portal';

function QueueStoreBootScreen({ isRemote }: { isRemote: boolean }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900/80 p-6 text-center shadow-2xl">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-500/15">
          {isRemote ? (
            <Wifi className="h-7 w-7 text-indigo-300" />
          ) : (
            <Smartphone className="h-7 w-7 text-indigo-300" />
          )}
        </div>
        <h1 className="text-lg font-semibold text-white">
          {isRemote ? 'Connecting to queue backend' : 'Loading local queue data'}
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          {isRemote
            ? 'Restoring merchant session and shared queue state.'
            : 'Restoring your last single-device session.'}
        </p>
        <div className="mt-5 inline-flex items-center gap-2 rounded-full bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          Sync mode: {isRemote ? 'remote' : 'local'}
        </div>
      </div>
    </div>
  );
}

export function QueueProvider({ children }: { children: ReactNode }) {
  const adapter = useMemo(() => createQueueStoreAdapter(), []);
  const initialRemoteStoreId = useMemo(
    () => (adapter.mode === 'remote' ? resolveInitialRemoteStoreId() : undefined),
    [adapter.mode]
  );
  const [requestedPortal, setRequestedPortal] = useState<Portal>(() => resolveInitialPortal());
  const [requestedRemoteStoreId, setRequestedRemoteStoreId] = useState<string | undefined>(
    initialRemoteStoreId
  );
  const [store, setStore] = useState<QueueStoreState>(() =>
    adapter.getInitialState(initialRemoteStoreId)
  );
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(
    adapter.mode === 'remote' ? 'syncing' : 'connected'
  );
  const [merchantProfile, setMerchantProfile] = useState<MerchantProfile | null>(null);
  const [recentProvisioning, setRecentProvisioning] = useState<MerchantProvisioning | null>(null);
  const [hydratedRemoteStoreId, setHydratedRemoteStoreId] = useState<string | null>(
    adapter.mode === 'remote' ? null : 'local'
  );
  const [sessionReady, setSessionReady] = useState<boolean>(adapter.mode === 'local');
  const storeRef = useRef(store);
  const syncStatusRef = useRef(syncStatus);
  const mutationQueueRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    storeRef.current = store;
  }, [store]);

  useEffect(() => {
    syncStatusRef.current = syncStatus;
  }, [syncStatus]);

  const replaceStore = useCallback((nextState: QueueStoreState) => {
    storeRef.current = nextState;
    setStore(nextState);
  }, []);

  const updateStore = useCallback((updater: (prev: QueueStoreState) => QueueStoreState) => {
    const nextState = updater(storeRef.current);
    storeRef.current = nextState;
    setStore(nextState);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const syncRouteContext = () => {
      setRequestedPortal(resolveInitialPortal());

      if (adapter.mode === 'remote') {
        setRequestedRemoteStoreId(resolveInitialRemoteStoreId());
      }
    };

    window.addEventListener('popstate', syncRouteContext);

    return () => {
      window.removeEventListener('popstate', syncRouteContext);
    };
  }, [adapter.mode]);

  const isCustomerPortal = requestedPortal === 'customer';
  const activeRemoteStoreId =
    adapter.mode === 'remote'
      ? (
          isCustomerPortal
            ? requestedRemoteStoreId || resolveInitialRemoteStoreId()
            : store.auth.storeId || requestedRemoteStoreId || resolveInitialRemoteStoreId()
        ).toUpperCase()
      : undefined;
  const fetchScope: QueueFetchScope =
    adapter.mode === 'remote' && isCustomerPortal
      ? 'public'
      : store.auth.isLoggedIn
        ? 'merchant'
        : 'public';
  const isHydrated =
    sessionReady && (adapter.mode === 'local' || hydratedRemoteStoreId === activeRemoteStoreId);

  const applyNextState = useCallback(
    (nextState: QueueStoreState) => {
      const currentAuth = storeRef.current.auth;
      const shouldPreserveMerchantAuth =
        adapter.mode === 'remote' && currentAuth.isLoggedIn && !isCustomerPortal;
      const resolvedState =
        shouldPreserveMerchantAuth
          ? {
              ...nextState,
              auth: currentAuth,
            }
          : nextState;

      replaceStore(resolvedState);
      void adapter.persist(resolvedState);
    },
    [adapter, isCustomerPortal, replaceStore]
  );

  const applyServerStateIfCurrent = useCallback(
    (nextState: QueueStoreState) => {
      if (nextState.version < storeRef.current.version) {
        return;
      }

      applyNextState(nextState);
    },
    [applyNextState]
  );

  const rollbackOptimisticState = useCallback(
    (previousState: QueueStoreState, optimisticState: QueueStoreState) => {
      if (storeRef.current.version > optimisticState.version) {
        return;
      }

      applyNextState(previousState);
    },
    [applyNextState]
  );

  const beginRemoteSync = useCallback(() => {
    if (adapter.mode === 'remote' && syncStatusRef.current !== 'connected') {
      setSyncStatus('syncing');
    }
  }, [adapter.mode]);

  const markRemoteSyncError = useCallback(() => {
    if (adapter.mode === 'remote') {
      setSyncStatus('error');
    }
  }, [adapter.mode]);

  const markRemoteConnected = useCallback(() => {
    if (adapter.mode === 'remote') {
      setSyncStatus('connected');
    }
  }, [adapter.mode]);

  const enqueueMutation = useCallback(<T,>(mutation: () => Promise<T>): Promise<T> => {
    const queued = mutationQueueRef.current
      .catch(() => undefined)
      .then(mutation);

    mutationQueueRef.current = queued.then(
      () => undefined,
      () => undefined
    );

    return queued;
  }, []);

  useEffect(() => {
    if (adapter.mode !== 'remote') {
      return;
    }

    let isActive = true;

    if (isCustomerPortal) {
      queueMicrotask(() => {
        if (!isActive) {
          return;
        }

        setMerchantProfile(null);
        setSessionReady(true);
      });

      return () => {
        isActive = false;
      };
    }

    void adapter.restoreAuth().then(auth => {
      if (!isActive) {
        return;
      }

      if (auth) {
        updateStore(prev => ({
          ...prev,
          auth,
        }));
      } else {
        setMerchantProfile(null);
        updateStore(prev => ({
          ...prev,
          auth: {
            storeId: '',
            storeName: '',
            isLoggedIn: false,
          },
        }));
      }

      setSessionReady(true);
    });

    return () => {
      isActive = false;
    };
  }, [adapter, isCustomerPortal, updateStore]);

  // Use a ref to avoid re-triggering hydration when fetchScope changes (login/logout).
  // In local mode, fetchScope changes should NOT cause a full re-hydrate because
  // hydrate() reads from localStorage which may not yet have the updated auth state,
  // causing a loop: login → fetchScope changes → hydrate reads stale state → resets auth → loop.
  const fetchScopeRef = useRef(fetchScope);

  useEffect(() => {
    fetchScopeRef.current = fetchScope;
  }, [fetchScope]);

  useEffect(() => {
    if (!sessionReady) {
      return;
    }

    let isActive = true;

    void adapter
      .hydrate(activeRemoteStoreId, fetchScopeRef.current)
      .then(state => {
        if (!isActive) {
          return;
        }

        applyNextState(state);

        if (adapter.mode === 'remote') {
          setHydratedRemoteStoreId(activeRemoteStoreId ?? null);
          setSyncStatus('connected');
        }
      })
      .catch(() => {
        if (!isActive || adapter.mode !== 'remote') {
          return;
        }

        setSyncStatus('offline');
      });

    const unsubscribe = adapter.subscribe(
      activeRemoteStoreId,
      fetchScopeRef.current,
      state => {
        applyServerStateIfCurrent(state);
      },
      status => {
        if (!isActive) {
          return;
        }

        setSyncStatus(status);
      }
    );

    return () => {
      isActive = false;
      unsubscribe();
    };
    // Note: fetchScope is intentionally excluded to prevent login/logout re-hydration loops.
  }, [activeRemoteStoreId, adapter, applyNextState, applyServerStateIfCurrent, sessionReady]);

  useEffect(() => {
    if (!sessionReady) {
      return;
    }

    if (!store.auth.isLoggedIn) {
      return;
    }

    let isActive = true;

    void adapter
      .fetchMerchantProfile(store.auth)
      .then(profile => {
        if (!isActive) {
          return;
        }

        setMerchantProfile(profile);
      })
      .catch(() => {
        if (!isActive || adapter.mode !== 'remote') {
          return;
        }

        setSyncStatus('error');
      });

    return () => {
      isActive = false;
    };
  }, [adapter, sessionReady, store.auth]);

  const hydrateRemoteMerchantState = useCallback(async (auth: MerchantAuth) => {
    if (adapter.mode !== 'remote') {
      return;
    }

    const nextState = await adapter.hydrate(auth.storeId, 'merchant');
    applyNextState(nextState);
    setHydratedRemoteStoreId(auth.storeId.toUpperCase());
    setSyncStatus('connected');
  }, [adapter, applyNextState]);

  const login = useCallback(async (storeId: string, password: string): Promise<boolean> => {
    beginRemoteSync();

    try {
      const auth = await adapter.login(storeId, password);

      if (!auth) {
        markRemoteSyncError();
        return false;
      }

      updateStore(prev => ({
        ...prev,
        auth,
      }));

      if (adapter.mode === 'remote') {
        await hydrateRemoteMerchantState(auth);
      }

      return true;
    } catch (error) {
      if (adapter.mode === 'remote') {
        setSyncStatus('offline');
      }

      throw error;
    }
  }, [adapter, beginRemoteSync, hydrateRemoteMerchantState, markRemoteSyncError, updateStore]);

  const registerMerchant = useCallback(async (input: MerchantRegistrationInput): Promise<void> => {
    beginRemoteSync();

    try {
      const result = await adapter.registerMerchant(input);
      updateStore(prev => ({
        ...prev,
        auth: result.auth,
      }));
      setMerchantProfile(result.profile);
      setRecentProvisioning(result.provisioning);

      if (adapter.mode === 'remote') {
        await hydrateRemoteMerchantState(result.auth);
      }
    } catch (error) {
      markRemoteSyncError();
      throw error;
    }
  }, [adapter, beginRemoteSync, hydrateRemoteMerchantState, markRemoteSyncError, updateStore]);

  const logout = useCallback(async (): Promise<void> => {
    beginRemoteSync();
    await adapter.logout(storeRef.current.auth);

    updateStore(prev => {
      if (adapter.mode === 'remote') {
        return {
          ...prev,
          auth: {
            storeId: '',
            storeName: '',
            isLoggedIn: false,
          },
        };
      }

      return createInitialQueueState();
    });

    clearActiveCustomerToken(activeRemoteStoreId);
    setMerchantProfile(null);
    setRecentProvisioning(null);
    if (adapter.mode === 'remote') {
      setSyncStatus('connected');
    }
  }, [activeRemoteStoreId, adapter, beginRemoteSync, updateStore]);

  const dismissProvisioning = useCallback(() => {
    setRecentProvisioning(null);
  }, []);

  const setTables = useCallback(async (tables: Table[]): Promise<void> => {
    try {
      const nextState = await enqueueMutation(() => adapter.setTables(storeRef.current, tables));
      applyServerStateIfCurrent(nextState);
      markRemoteConnected();
    } catch (error) {
      markRemoteSyncError();
      throw error;
    }
  }, [adapter, applyServerStateIfCurrent, enqueueMutation, markRemoteConnected, markRemoteSyncError]);

  const addTable = useCallback(async (capacity: number): Promise<void> => {
    const previousState = storeRef.current;
    const optimisticState = applyAutomaticQueueState(addTableState(previousState, capacity));
    applyNextState(optimisticState);

    try {
      const nextState = await enqueueMutation(() => adapter.addTable(previousState, capacity));
      applyServerStateIfCurrent(nextState);
      markRemoteConnected();
    } catch (error) {
      rollbackOptimisticState(previousState, optimisticState);
      markRemoteSyncError();
      throw error;
    }
  }, [adapter, applyNextState, applyServerStateIfCurrent, enqueueMutation, markRemoteConnected, markRemoteSyncError, rollbackOptimisticState]);

  const removeTable = useCallback(async (tableId: string): Promise<void> => {
    const previousState = storeRef.current;
    const optimisticState = applyAutomaticQueueState(removeTableState(previousState, tableId));
    if (optimisticState !== previousState) {
      applyNextState(optimisticState);
    }

    try {
      const nextState = await enqueueMutation(() => adapter.removeTable(previousState, tableId));
      applyServerStateIfCurrent(nextState);
      markRemoteConnected();
    } catch (error) {
      if (optimisticState !== previousState) {
        rollbackOptimisticState(previousState, optimisticState);
      }
      markRemoteSyncError();
      throw error;
    }
  }, [adapter, applyNextState, applyServerStateIfCurrent, enqueueMutation, markRemoteConnected, markRemoteSyncError, rollbackOptimisticState]);

  const markTableCleaning = useCallback(async (tableId: string): Promise<void> => {
    const previousState = storeRef.current;
    const optimisticState = applyAutomaticQueueState(markTableCleaningState(previousState, tableId));
    if (optimisticState !== previousState) {
      applyNextState(optimisticState);
    }

    try {
      const nextState = await enqueueMutation(() =>
        adapter.markTableCleaning(previousState, tableId)
      );
      applyServerStateIfCurrent(nextState);
      markRemoteConnected();
    } catch (error) {
      if (optimisticState !== previousState) {
        rollbackOptimisticState(previousState, optimisticState);
      }
      markRemoteSyncError();
      throw error;
    }
  }, [adapter, applyNextState, applyServerStateIfCurrent, enqueueMutation, markRemoteConnected, markRemoteSyncError, rollbackOptimisticState]);

  const markTableAvailable = useCallback(async (tableId: string): Promise<void> => {
    const previousState = storeRef.current;
    const optimisticState = applyAutomaticQueueState(markTableAvailableState(previousState, tableId));
    if (optimisticState !== previousState) {
      applyNextState(optimisticState);
    }

    try {
      const nextState = await enqueueMutation(() =>
        adapter.markTableAvailable(previousState, tableId)
      );
      applyServerStateIfCurrent(nextState);
      markRemoteConnected();
    } catch (error) {
      if (optimisticState !== previousState) {
        rollbackOptimisticState(previousState, optimisticState);
      }
      markRemoteSyncError();
      throw error;
    }
  }, [adapter, applyNextState, applyServerStateIfCurrent, enqueueMutation, markRemoteConnected, markRemoteSyncError, rollbackOptimisticState]);

  const releaseTable = useCallback(async (tableId: string): Promise<void> => {
    beginRemoteSync();

    try {
      const nextState = await enqueueMutation(() => adapter.releaseTable(storeRef.current, tableId));
      applyServerStateIfCurrent(nextState);
      markRemoteConnected();
    } catch (error) {
      markRemoteSyncError();
      throw error;
    }
  }, [adapter, applyServerStateIfCurrent, beginRemoteSync, enqueueMutation, markRemoteConnected, markRemoteSyncError]);

  const resetQueue = useCallback(async (): Promise<void> => {
    const previousState = storeRef.current;
    const optimisticState = applyAutomaticQueueState(clearQueueState(previousState));
    applyNextState(optimisticState);

    try {
      const nextState = await enqueueMutation(() => adapter.resetQueue(previousState));
      applyServerStateIfCurrent(nextState);
      markRemoteConnected();
    } catch (error) {
      rollbackOptimisticState(previousState, optimisticState);
      markRemoteSyncError();
      throw error;
    }
  }, [adapter, applyNextState, applyServerStateIfCurrent, enqueueMutation, markRemoteConnected, markRemoteSyncError, rollbackOptimisticState]);

  const setAutoMode = useCallback(async (enabled: boolean): Promise<void> => {
    const previousState = storeRef.current;
    const optimisticState = applyAutomaticQueueState(setAutoModeState(previousState, enabled));
    if (optimisticState !== previousState) {
      applyNextState(optimisticState);
    }

    try {
      const nextState = await enqueueMutation(() => adapter.setAutoMode(previousState, enabled));
      applyServerStateIfCurrent(nextState);
      markRemoteConnected();
    } catch (error) {
      if (optimisticState !== previousState) {
        rollbackOptimisticState(previousState, optimisticState);
      }
      markRemoteSyncError();
      throw error;
    }
  }, [adapter, applyNextState, applyServerStateIfCurrent, enqueueMutation, markRemoteConnected, markRemoteSyncError, rollbackOptimisticState]);

  const addCustomer = useCallback(async (phone: string, partySize: number, email?: string) => {
    const previousState = storeRef.current;
    const shouldOptimisticallyAdd =
      !(adapter.mode === 'remote' && previousState.auth.isLoggedIn);
    const optimisticResult = addCustomerState(previousState, phone, partySize, email);
    if (shouldOptimisticallyAdd && optimisticResult.state !== previousState) {
      applyNextState(applyAutomaticQueueState(optimisticResult.state));
    }

    try {
      const result = await enqueueMutation(() =>
        adapter.addCustomer(previousState, phone, partySize, email)
      );
      applyServerStateIfCurrent(result.state);
      markRemoteConnected();
      return result.result;
    } catch (error) {
      if (shouldOptimisticallyAdd && optimisticResult.state !== previousState) {
        rollbackOptimisticState(previousState, optimisticResult.state);
      }
      markRemoteSyncError();
      throw error;
    }
  }, [adapter, applyNextState, applyServerStateIfCurrent, enqueueMutation, markRemoteConnected, markRemoteSyncError, rollbackOptimisticState]);

  const addWalkInCustomer = useCallback(async (partySize: number, name?: string) => {
    const previousState = storeRef.current;
    const shouldOptimisticallyAdd =
      !(adapter.mode === 'remote' && previousState.auth.isLoggedIn);
    const optimisticResult = addCustomerState(previousState, '', partySize, undefined, {
      name,
      source: 'walk-in',
    });
    if (shouldOptimisticallyAdd && optimisticResult.state !== previousState) {
      applyNextState(applyAutomaticQueueState(optimisticResult.state));
    }

    try {
      const result = await enqueueMutation(() =>
        adapter.addWalkInCustomer(previousState, partySize, name)
      );
      applyServerStateIfCurrent(result.state);
      markRemoteConnected();
      return result.result;
    } catch (error) {
      if (shouldOptimisticallyAdd && optimisticResult.state !== previousState) {
        rollbackOptimisticState(previousState, optimisticResult.state);
      }
      markRemoteSyncError();
      throw error;
    }
  }, [adapter, applyNextState, applyServerStateIfCurrent, enqueueMutation, markRemoteConnected, markRemoteSyncError, rollbackOptimisticState]);

  const prepareCustomerEntry = useCallback(async (): Promise<void> => {
    await adapter.prepareCustomerEntry(storeRef.current);
  }, [adapter]);

  const callCustomer = useCallback(async (customerId: string, tableId?: string): Promise<void> => {
    const previousState = storeRef.current;
    const optimisticState = applyAutomaticQueueState(callCustomerState(previousState, customerId, tableId));
    if (optimisticState !== previousState) {
      applyNextState(optimisticState);
    }

    try {
      const nextState = await enqueueMutation(() =>
        adapter.callCustomer(previousState, customerId, tableId)
      );
      applyServerStateIfCurrent(nextState);
      markRemoteConnected();
    } catch (error) {
      if (optimisticState !== previousState) {
        rollbackOptimisticState(previousState, optimisticState);
      }
      markRemoteSyncError();
      throw error;
    }
  }, [adapter, applyNextState, applyServerStateIfCurrent, enqueueMutation, markRemoteConnected, markRemoteSyncError, rollbackOptimisticState]);

  const seatCustomer = useCallback(async (customerId: string): Promise<void> => {
    const previousState = storeRef.current;
    const optimisticState = applyAutomaticQueueState(seatCustomerState(previousState, customerId));
    if (optimisticState !== previousState) {
      applyNextState(optimisticState);
    }

    try {
      const nextState = await enqueueMutation(() =>
        adapter.seatCustomer(previousState, customerId)
      );
      applyServerStateIfCurrent(nextState);
      markRemoteConnected();
    } catch (error) {
      if (optimisticState !== previousState) {
        rollbackOptimisticState(previousState, optimisticState);
      }
      markRemoteSyncError();
      throw error;
    }
  }, [adapter, applyNextState, applyServerStateIfCurrent, enqueueMutation, markRemoteConnected, markRemoteSyncError, rollbackOptimisticState]);

  const confirmArrival = useCallback(async (customerId: string): Promise<void> => {
    const previousState = storeRef.current;
    const optimisticState = applyAutomaticQueueState(confirmArrivalState(previousState, customerId));
    if (optimisticState !== previousState) {
      applyNextState(optimisticState);
    }

    try {
      const nextState = await enqueueMutation(() =>
        adapter.confirmArrival(previousState, customerId)
      );
      applyServerStateIfCurrent(nextState);
      markRemoteConnected();
    } catch (error) {
      if (optimisticState !== previousState) {
        rollbackOptimisticState(previousState, optimisticState);
      }
      markRemoteSyncError();
      throw error;
    }
  }, [adapter, applyNextState, applyServerStateIfCurrent, enqueueMutation, markRemoteConnected, markRemoteSyncError, rollbackOptimisticState]);

  const expireCustomer = useCallback(async (customerId: string): Promise<void> => {
    const previousState = storeRef.current;
    const optimisticState = applyAutomaticQueueState(expireCustomerState(previousState, customerId));
    if (optimisticState !== previousState) {
      applyNextState(optimisticState);
    }

    try {
      const nextState = await enqueueMutation(() =>
        adapter.expireCustomer(previousState, customerId)
      );
      applyServerStateIfCurrent(nextState);
      markRemoteConnected();
    } catch (error) {
      if (optimisticState !== previousState) {
        rollbackOptimisticState(previousState, optimisticState);
      }
      markRemoteSyncError();
      throw error;
    }
  }, [adapter, applyNextState, applyServerStateIfCurrent, enqueueMutation, markRemoteConnected, markRemoteSyncError, rollbackOptimisticState]);

  const leaveQueue = useCallback(async (customerId: string): Promise<void> => {
    beginRemoteSync();

    try {
      const nextState = await enqueueMutation(() => adapter.leaveQueue(storeRef.current, customerId));
      applyServerStateIfCurrent(nextState);
      markRemoteConnected();
    } catch (error) {
      markRemoteSyncError();
      throw error;
    }
  }, [adapter, applyServerStateIfCurrent, beginRemoteSync, enqueueMutation, markRemoteConnected, markRemoteSyncError]);

  const removeCustomer = useCallback(async (customerId: string): Promise<void> => {
    const previousState = storeRef.current;
    const optimisticState = applyAutomaticQueueState(removeCustomerFromState(previousState, customerId));
    if (optimisticState !== previousState) {
      applyNextState(optimisticState);
    }

    try {
      const nextState = await enqueueMutation(() =>
        adapter.removeCustomer(previousState, customerId)
      );
      applyServerStateIfCurrent(nextState);
      markRemoteConnected();
    } catch (error) {
      if (optimisticState !== previousState) {
        rollbackOptimisticState(previousState, optimisticState);
      }
      markRemoteSyncError();
      throw error;
    }
  }, [adapter, applyNextState, applyServerStateIfCurrent, enqueueMutation, markRemoteConnected, markRemoteSyncError, rollbackOptimisticState]);

  const requeueCustomer = useCallback(async (customerId: string): Promise<void> => {
    const previousState = storeRef.current;
    const optimisticState = applyAutomaticQueueState(requeueCustomerState(previousState, customerId));
    if (optimisticState !== previousState) {
      applyNextState(optimisticState);
    }

    try {
      const nextState = await enqueueMutation(() =>
        adapter.requeueCustomer(previousState, customerId)
      );
      applyServerStateIfCurrent(nextState);
      markRemoteConnected();
    } catch (error) {
      if (optimisticState !== previousState) {
        rollbackOptimisticState(previousState, optimisticState);
      }
      markRemoteSyncError();
      throw error;
    }
  }, [adapter, applyNextState, applyServerStateIfCurrent, enqueueMutation, markRemoteConnected, markRemoteSyncError, rollbackOptimisticState]);

  const getCustomerByPhone = useCallback((phone: string) => {
    return store.customers.find(
      customer =>
        customer.phone === phone &&
        (customer.status === 'waiting' ||
          customer.status === 'called' ||
          customer.status === 'confirmed')
    );
  }, [store.customers]);

  const getWaitingAhead = useCallback((customer: Customer): number => {
    return store.customers.filter(
      entry => entry.status === 'waiting' && entry.queueNumber < customer.queueNumber
    ).length;
  }, [store.customers]);

  const getEstimatedWait = useCallback((customer: Customer): number => {
    return calcEstimatedWait(getWaitingAhead(customer));
  }, [getWaitingAhead]);

  const refreshMerchantProfile = useCallback(async (): Promise<MerchantProfile | null> => {
    if (!storeRef.current.auth.isLoggedIn) {
      setMerchantProfile(null);
      return null;
    }

    try {
      const profile = await adapter.fetchMerchantProfile(storeRef.current.auth);
      setMerchantProfile(profile);
      return profile;
    } catch (error) {
      markRemoteSyncError();
      throw error;
    }
  }, [adapter, markRemoteSyncError]);

  const updateMerchantProfileState = useCallback(
    async (input: MerchantProfileUpdateInput): Promise<MerchantProfile | null> => {
      if (!storeRef.current.auth.isLoggedIn) {
        return null;
      }

      beginRemoteSync();

      try {
        const profile = await adapter.updateMerchantProfile(storeRef.current.auth, input);
        setMerchantProfile(profile);
        if (profile) {
          updateStore(prev => ({
            ...prev,
            auth: prev.auth.isLoggedIn
              ? {
                  ...prev.auth,
                  storeName: profile.storeName,
                }
              : prev.auth,
          }));
        }
        return profile;
      } catch (error) {
        markRemoteSyncError();
        throw error;
      }
    },
    [adapter, beginRemoteSync, markRemoteSyncError, updateStore]
  );

  const updateMerchantPasswordState = useCallback(
    async (input: MerchantPasswordUpdateInput): Promise<void> => {
      if (!storeRef.current.auth.isLoggedIn) {
        return;
      }

      beginRemoteSync();

      try {
        await adapter.updateMerchantPassword(storeRef.current.auth, input);
        setSyncStatus('connected');
      } catch (error) {
        markRemoteSyncError();
        throw error;
      }
    },
    [adapter, beginRemoteSync, markRemoteSyncError]
  );

  const startSubscriptionCheckout = useCallback(
    async (planCode?: MerchantPlanCode): Promise<string> => {
      if (!storeRef.current.auth.isLoggedIn) {
        throw new Error('Merchant login is required before starting billing.');
      }

      beginRemoteSync();

      try {
        const url = await adapter.startSubscriptionCheckout(storeRef.current.auth, planCode);
        setSyncStatus('connected');
        return url;
      } catch (error) {
        markRemoteSyncError();
        throw error;
      }
    },
    [adapter, beginRemoteSync, markRemoteSyncError]
  );

  const openBillingPortal = useCallback(async (): Promise<string> => {
    if (!storeRef.current.auth.isLoggedIn) {
      throw new Error('Merchant login is required before opening billing.');
    }

    beginRemoteSync();

    try {
      const url = await adapter.openBillingPortal(storeRef.current.auth);
      setSyncStatus('connected');
      return url;
    } catch (error) {
      markRemoteSyncError();
      throw error;
    }
  }, [adapter, beginRemoteSync, markRemoteSyncError]);

  const sendTestNotificationEmail = useCallback(async (recipient?: string): Promise<void> => {
    if (!storeRef.current.auth.isLoggedIn) {
      throw new Error('Merchant login is required before sending a test notification.');
    }

    beginRemoteSync();

    try {
      await adapter.sendTestNotificationEmail(storeRef.current.auth, recipient);
      setSyncStatus('connected');
    } catch (error) {
      markRemoteSyncError();
      throw error;
    }
  }, [adapter, beginRemoteSync, markRemoteSyncError]);

  const fetchNotificationLogs = useCallback(async (limit?: number) => {
    return adapter.fetchNotificationLogs(storeRef.current, limit);
  }, [adapter]);

  const fetchQueueEvents = useCallback(async (limit?: number) => {
    return adapter.fetchQueueEvents(storeRef.current, limit);
  }, [adapter]);

  const validateCustomerSession = useCallback(async (customerId: string): Promise<boolean> => {
    return adapter.validateCustomerSession(storeRef.current, customerId);
  }, [adapter]);

  const value: QueueContextType = {
    customers: store.customers,
    tables: store.tables,
    auth: store.auth,
    merchantProfile,
    recentProvisioning,
    isTablesConfigured: store.isTablesConfigured,
    autoMode: store.autoMode,
    syncMode: adapter.mode,
    syncStatus,
    login,
    registerMerchant,
    logout,
    dismissProvisioning,
    setTables,
    addTable,
    removeTable,
    markTableCleaning,
    markTableAvailable,
    releaseTable,
    resetQueue,
    setAutoMode,
    addCustomer,
    addWalkInCustomer,
    prepareCustomerEntry,
    callCustomer,
    confirmArrival,
    seatCustomer,
    expireCustomer,
    requeueCustomer,
    leaveQueue,
    removeCustomer,
    getCustomerByPhone,
    getWaitingAhead,
    getEstimatedWait,
    refreshMerchantProfile,
    updateMerchantProfile: updateMerchantProfileState,
    updateMerchantPassword: updateMerchantPasswordState,
    startSubscriptionCheckout,
    openBillingPortal,
    sendTestNotificationEmail,
    validateCustomerSession,
    fetchNotificationLogs,
    fetchQueueEvents,
  };

  if (!isHydrated) {
    return <QueueStoreBootScreen isRemote={adapter.mode === 'remote'} />;
  }

  return <QueueContext.Provider value={value}>{children}</QueueContext.Provider>;
}
