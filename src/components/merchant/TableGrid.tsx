import { useMemo, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  PhoneCall,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { useQueue } from '../../context/useQueue';
import type { Customer, SyncStatus, Table } from '../../types';
import { getTableDisplayMeta } from '../../utils/tableLabels';
import ConfirmDialog from './ConfirmDialog';

// ── Bold, visually distinct status styles ──
const STATUS_STYLES = {
  available: {
    border: 'border-emerald-400/60',
    background: 'bg-emerald-500/20',
    dot: 'bg-emerald-400',
    label: 'Open',
    labelClasses: 'bg-emerald-500/30 text-emerald-100 font-bold',
    icon: <CheckCircle2 className="h-2.5 w-2.5 text-emerald-300" />,
  },
  reserved: {
    border: 'border-amber-400/60',
    background: 'bg-amber-500/20',
    dot: 'bg-amber-400 animate-pulse',
    label: 'Hold',
    labelClasses: 'bg-amber-500/30 text-amber-100 font-bold',
    icon: <Clock className="h-2.5 w-2.5 text-amber-300" />,
  },
  occupied: {
    border: 'border-rose-400/60',
    background: 'bg-rose-500/20',
    dot: 'bg-rose-400',
    label: 'Used',
    labelClasses: 'bg-rose-500/30 text-rose-100 font-bold',
    icon: <Users className="h-2.5 w-2.5 text-rose-300" />,
  },
  cleaning: {
    border: 'border-sky-400/60',
    background: 'bg-sky-500/20',
    dot: 'bg-sky-400 animate-pulse',
    label: 'Clean',
    labelClasses: 'bg-sky-500/30 text-sky-100 font-bold',
    icon: <Sparkles className="h-2.5 w-2.5 text-sky-300" />,
  },
} as const;

const SYNC_STATUS_COPY: Partial<Record<SyncStatus, string>> = {
  offline: 'Table updates are offline. Actions may fail.',
  error: 'The last table update failed. Please retry.',
  'conflict-refreshed': 'Another device updated the floor.',
};

const ADD_TABLE_CAPACITIES = [2, 3, 4, 6, 8];

function formatSeatedDuration(customer: Customer | undefined): string {
  if (!customer?.callTime) return '';

  const minutes = Math.floor((Date.now() - customer.callTime.getTime()) / 60000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes === 0 ? `${hours}h` : `${hours}h${remainingMinutes}m`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours === 0 ? `${days}d` : `${days}d${remainingHours}h`;
}

interface TableCardProps {
  table: Table;
  tableLabel: string;
  eligibleCustomers: Customer[];
  assignedCustomer?: Customer;
  onAssign: (customerId: string) => void;
  onRelease: () => void;
  onMarkCleaning: () => void;
  onMarkAvailable: () => void;
  onRemove: () => void;
  canRemove: boolean;
}

function TableCard({
  table,
  tableLabel,
  eligibleCustomers,
  assignedCustomer,
  onAssign,
  onRelease,
  onMarkCleaning,
  onMarkAvailable,
  onRemove,
  canRemove,
}: TableCardProps) {
  const styles = STATUS_STYLES[table.status];
  const nextEligibleCustomer = eligibleCustomers[0];

  return (
    <div
      className={`flex min-w-0 flex-col rounded-md border-2 px-2 py-2 transition-all duration-200 sm:px-1.5 sm:py-1 ${styles.background} ${styles.border}`}
    >
      {/* Row 1: table name + status badge */}
      <div className="flex items-center justify-between gap-1">
        <p className="truncate font-mono text-[13px] font-black tracking-wide text-white leading-tight">
          {tableLabel}
        </p>
        <span
          className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[7px] uppercase tracking-wider ${styles.labelClasses}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${styles.dot}`} />
          {styles.label}
        </span>
      </div>

      {/* Row 2: capacity + guest info */}
      <div className="mt-0.5 flex items-center justify-between gap-1 text-[9px] text-slate-400">
        <span className="flex items-center gap-0.5">
          <Users className="h-2.5 w-2.5" />{table.capacity}p
        </span>
        {assignedCustomer && (
          <span className="min-w-0 truncate font-semibold text-slate-300">
            #{assignedCustomer.queueNumber} · {assignedCustomer.partySize}p
            {table.status === 'occupied' && ` · ${formatSeatedDuration(assignedCustomer)}`}
          </span>
        )}
      </div>

      {/* Row 3: Actions – always visible, no hover */}
      <div className="mt-2 flex flex-wrap items-center gap-1 sm:mt-1 sm:gap-0.5">
        {table.status === 'available' && (
          <>
            {nextEligibleCustomer ? (
              <button
                id={`assign-${table.id}-${nextEligibleCustomer.id}`}
                onClick={() => onAssign(nextEligibleCustomer.id)}
                className="inline-flex min-h-8 flex-1 items-center justify-center gap-0.5 rounded bg-emerald-600/80 px-1 py-1 text-[9px] font-semibold text-white transition-colors active:bg-emerald-500 sm:min-h-0 sm:py-0.5 sm:text-[8px]"
              >
                <PhoneCall className="h-2 w-2" />
                #{nextEligibleCustomer.queueNumber}
              </button>
            ) : (
              <span className="flex-1 text-center text-[8px] text-slate-500">Idle</span>
            )}
            {canRemove && (
              <button
                id={`remove-table-${table.id}`}
                onClick={onRemove}
                className="inline-flex h-8 w-8 items-center justify-center rounded bg-slate-700/60 p-0.5 text-slate-400 transition-colors active:bg-rose-500/20 active:text-rose-300 sm:h-auto sm:w-auto"
                title="Remove table"
              >
                <Trash2 className="h-2.5 w-2.5" />
              </button>
            )}
          </>
        )}

        {table.status === 'reserved' && (
          <button
            id={`release-${table.id}`}
            onClick={onRelease}
            className="inline-flex min-h-8 flex-1 items-center justify-center gap-0.5 rounded border border-slate-600 bg-slate-800 px-1 py-1 text-[9px] font-semibold text-slate-200 transition-colors active:bg-slate-700 sm:min-h-0 sm:py-0.5 sm:text-[8px]"
          >
            <RefreshCw className="h-2 w-2" />
            Release
          </button>
        )}

        {table.status === 'occupied' && (
          <button
            id={`done-${table.id}`}
            onClick={onMarkCleaning}
            className="inline-flex min-h-8 flex-1 items-center justify-center gap-0.5 rounded bg-sky-600/70 px-1 py-1 text-[9px] font-semibold text-white transition-colors active:bg-sky-500 sm:min-h-0 sm:py-0.5 sm:text-[8px]"
          >
            <Sparkles className="h-2 w-2" />
            Done → Clean
          </button>
        )}

        {table.status === 'cleaning' && (
          <button
            id={`ready-${table.id}`}
            onClick={onMarkAvailable}
            className="inline-flex min-h-8 flex-1 items-center justify-center gap-0.5 rounded bg-emerald-600/80 px-1 py-1 text-[9px] font-semibold text-white transition-colors active:bg-emerald-500 sm:min-h-0 sm:py-0.5 sm:text-[8px]"
          >
            <CheckCircle2 className="h-2 w-2" />
            Ready
          </button>
        )}
      </div>
    </div>
  );
}

export default function TableGrid() {
  const {
    addTable,
    callCustomer,
    customers,
    markTableAvailable,
    markTableCleaning,
    releaseTable,
    removeTable,
    syncMode,
    syncStatus,
    tables,
  } = useQueue();
  const [actionError, setActionError] = useState('');
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<{ id: string; label: string } | null>(null);

  const waitingCustomers = useMemo(
    () =>
      [...customers]
        .filter(customer => customer.status === 'waiting')
        .sort((left, right) => left.queueNumber - right.queueNumber),
    [customers]
  );

  const stats = {
    available: tables.filter(t => t.status === 'available').length,
    reserved: tables.filter(t => t.status === 'reserved').length,
    occupied: tables.filter(t => t.status === 'occupied').length,
    cleaning: tables.filter(t => t.status === 'cleaning').length,
  };

  const getAssignedCustomer = (table: Table): Customer | undefined => {
    if (!table.assignedCustomerId) return undefined;
    return customers.find(entry => entry.id === table.assignedCustomerId);
  };

  const getEligibleCustomers = (table: Table): Customer[] => {
    if (table.status !== 'available') return [];
    return waitingCustomers.filter(customer => customer.partySize <= table.capacity);
  };

  const runAction = async (action: () => Promise<void>) => {
    setActionError('');
    try {
      await action();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Action failed.');
    }
  };

  const handleAssign = (customerId: string, tableId: string) => {
    void runAction(() => callCustomer(customerId, tableId));
  };

  const handleRelease = (tableId: string) => {
    void runAction(() => releaseTable(tableId));
  };

  const handleAddTable = (capacity: number) => {
    void runAction(() => addTable(capacity));
  };

  const handleRemoveTable = () => {
    if (removeTarget) {
      void runAction(() => removeTable(removeTarget.id));
    }
    setRemoveTarget(null);
  };

  return (
    <div>
      {syncMode === 'remote' && syncStatus !== 'connected' && SYNC_STATUS_COPY[syncStatus] && (
        <div className="mb-1.5 rounded-md border border-sky-500/20 bg-sky-500/10 px-2 py-1 text-[10px] text-sky-200">
          {SYNC_STATUS_COPY[syncStatus]}
        </div>
      )}

      {actionError && (
        <div className="mb-1.5 rounded-md border border-rose-500/20 bg-rose-500/10 px-2 py-1 text-[10px] text-rose-200">
          {actionError}
        </div>
      )}

      {/* Legend + Add table button */}
      <div className="mb-2 flex flex-col items-stretch justify-between gap-2 sm:mb-1.5 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="flex flex-wrap items-center gap-2">
          {[
            { dot: 'bg-emerald-400', label: `${stats.available} Open` },
            { dot: 'bg-amber-400 animate-pulse', label: `${stats.reserved} Hold` },
            { dot: 'bg-rose-400', label: `${stats.occupied} Used` },
            { dot: 'bg-sky-400 animate-pulse', label: `${stats.cleaning} Clean` },
          ].map(item => (
            <div key={item.label} className="flex items-center gap-1">
              <div className={`h-2 w-2 rounded-full ${item.dot}`} />
              <span className="text-[9px] font-semibold text-slate-400">{item.label}</span>
            </div>
          ))}
        </div>

        <button
          id="addTableBtn"
          onClick={() => setShowAddPanel(prev => !prev)}
          className={`inline-flex min-h-9 items-center justify-center gap-1 rounded-md border px-2 py-1 text-[10px] font-semibold transition-colors active:bg-indigo-500/15 sm:min-h-0 sm:text-[9px] ${
            showAddPanel
              ? 'border-indigo-500/30 bg-indigo-500/15 text-indigo-200'
              : 'border-slate-700 bg-slate-800 text-slate-300'
          }`}
        >
          {showAddPanel ? <X className="h-2.5 w-2.5" /> : <Plus className="h-2.5 w-2.5" />}
          {showAddPanel ? 'Close' : 'Add Table'}
        </button>
      </div>

      {/* Add table panel */}
      {showAddPanel && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-md border border-dashed border-indigo-500/30 bg-indigo-500/5 px-2 py-1.5 animate-fade-in">
          <span className="w-full text-[10px] font-semibold text-indigo-300 sm:w-auto sm:text-[9px]">Add table:</span>
          {ADD_TABLE_CAPACITIES.map(cap => (
            <button
              key={cap}
              id={`add-table-cap-${cap}`}
              onClick={() => handleAddTable(cap)}
              className="inline-flex min-h-8 flex-1 items-center justify-center gap-0.5 rounded bg-indigo-600/60 px-2 py-1 text-[10px] font-semibold text-white transition-colors active:bg-indigo-500 sm:min-h-0 sm:flex-none sm:py-0.5 sm:text-[9px]"
            >
              <Plus className="h-2 w-2" />
              {cap}p
            </button>
          ))}
        </div>
      )}

      {/* Table grid – dense layout */}
      <div className="grid grid-cols-2 gap-2 sm:[grid-template-columns:repeat(auto-fill,minmax(112px,1fr))]">
        {tables.map(table => {
          const { label } = getTableDisplayMeta(table, tables);
          const canRemove = table.status === 'available';

          return (
            <TableCard
              key={table.id}
              table={table}
              tableLabel={label}
              eligibleCustomers={getEligibleCustomers(table)}
              assignedCustomer={getAssignedCustomer(table)}
              onAssign={customerId => handleAssign(customerId, table.id)}
              onRelease={() => handleRelease(table.id)}
              onMarkCleaning={() => { void runAction(() => markTableCleaning(table.id)); }}
              onMarkAvailable={() => { void runAction(() => markTableAvailable(table.id)); }}
              onRemove={() => setRemoveTarget({ id: table.id, label })}
              canRemove={canRemove}
            />
          );
        })}
      </div>

      {tables.length === 0 && (
        <div className="py-4 text-center text-[11px] text-slate-500">
          No tables configured. Use "Add Table" above or "Reconfigure Tables" in the menu.
        </div>
      )}

      {/* Confirm remove table */}
      <ConfirmDialog
        isOpen={removeTarget !== null}
        title="Remove Table"
        description={`Remove table ${removeTarget?.label ?? ''}? This cannot be undone. Tables can only be removed when they are available (not occupied, reserved, or cleaning).`}
        confirmLabel="Remove"
        variant="danger"
        onConfirm={handleRemoveTable}
        onCancel={() => setRemoveTarget(null)}
      />
    </div>
  );
}
