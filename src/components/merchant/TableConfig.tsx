import { useState } from 'react';
import { AlertCircle, Armchair, CheckCircle2, ChevronLeft, ChevronRight, Minus, Plus } from 'lucide-react';
import { useQueue } from '../../context/useQueue';
import type { Table } from '../../types';
import { buildDefaultTableName } from '../../utils/tableLabels';

interface TableConfigProps {
  onComplete: () => void;
  existingTables?: Table[];
  warningText?: string;
  beforeSave?: () => Promise<void>;
  onCancel?: () => void;
}

interface TableTemplate {
  label: string;
  capacity: number;
  description: string;
  color: string;
}

const TABLE_TEMPLATES: TableTemplate[] = [
  { label: 'Small', capacity: 3, description: '1-3 guests', color: 'from-emerald-500 to-teal-500' },
  { label: 'Medium', capacity: 4, description: '4 guests', color: 'from-blue-500 to-indigo-500' },
  { label: 'Large', capacity: 8, description: '5-8 guests', color: 'from-purple-500 to-pink-500' },
];

function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

function buildInitialCounts(existingTables: Table[] | undefined): Record<number, number> {
  if (!existingTables || existingTables.length === 0) {
    return { 3: 2, 4: 2, 8: 1 };
  }

  const counts: Record<number, number> = { 3: 0, 4: 0, 8: 0 };
  for (const table of existingTables) {
    if (table.capacity in counts) {
      counts[table.capacity] += 1;
    }
  }

  return counts;
}

export default function TableConfig({
  onComplete,
  existingTables,
  warningText,
  beforeSave,
  onCancel,
}: TableConfigProps) {
  const { setTables } = useQueue();
  const [tableCounts, setTableCounts] = useState<Record<number, number>>(() => buildInitialCounts(existingTables));
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');

  const updateCount = (capacity: number, delta: number) => {
    setTableCounts(prev => ({
      ...prev,
      [capacity]: Math.max(0, Math.min(10, (prev[capacity] ?? 0) + delta)),
    }));
  };

  const totalTables = Object.values(tableCounts).reduce((sum, value) => sum + value, 0);

  const handleConfirm = async () => {
    setError('');
    setIsSaving(true);

    const tables: Table[] = [];
    let index = 1;

    TABLE_TEMPLATES.forEach(template => {
      const count = tableCounts[template.capacity] ?? 0;

      for (let offset = 0; offset < count; offset += 1) {
        tables.push({
          id: generateId(),
          name: buildDefaultTableName(index),
          capacity: template.capacity,
          status: 'available',
        });
        index += 1;
      }
    });

    try {
      if (beforeSave) {
        await beforeSave();
      }

      await setTables(tables);
      onComplete();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save the table layout.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-950 via-indigo-950 to-slate-950 p-3 sm:p-4">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute right-1/4 top-1/3 h-80 w-80 rounded-full bg-indigo-600/10 blur-3xl" />
        <div className="absolute bottom-1/3 left-1/4 h-60 w-60 rounded-full bg-purple-600/10 blur-3xl" />
      </div>

      <div className="relative w-full max-w-lg animate-slide-up">
        <div className="mb-6 text-center sm:mb-8">
          {onCancel && (
            <button
              id="cancelTableConfigBtn"
              onClick={onCancel}
              className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-400 transition-colors hover:text-white"
            >
              <ChevronLeft className="h-4 w-4" />
              Back to dashboard
            </button>
          )}
          <div className="mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 shadow-lg shadow-indigo-500/30">
            <Armchair className="h-7 w-7 text-white" />
          </div>
          <h1 className="text-xl font-bold text-white sm:text-2xl">Configure Your Tables</h1>
          <p className="mt-1 text-sm text-slate-400">
            Set up the seating layout for your restaurant
          </p>
        </div>

        <div className="rounded-2xl border border-slate-700/50 bg-slate-900/80 p-4 shadow-2xl backdrop-blur-xl sm:p-6">
          {warningText && (
            <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 p-3">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-300" />
              <p className="text-xs text-amber-200">{warningText}</p>
            </div>
          )}

          <div className="mb-6 space-y-4">
            {TABLE_TEMPLATES.map(template => (
              <div
                key={template.capacity}
                className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-700/50 bg-slate-800/50 p-3 transition-all hover:border-slate-600/50 sm:flex-nowrap sm:gap-4 sm:p-4"
              >
                <div
                  className={`flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${template.color} shadow-lg`}
                >
                  <span className="text-sm font-bold text-white">{template.capacity}</span>
                </div>

                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-white">{template.label} Table</p>
                  <p className="text-xs text-slate-400">
                    {template.description} - up to {template.capacity} pax
                  </p>
                </div>

                <div className="ml-auto flex items-center gap-3">
                  <button
                    id={`dec-${template.capacity}`}
                    onClick={() => updateCount(template.capacity, -1)}
                    className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-700 text-white transition-colors hover:bg-slate-600 sm:h-8 sm:w-8"
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </button>
                  <span className="w-6 text-center text-lg font-bold text-white">
                    {tableCounts[template.capacity] ?? 0}
                  </span>
                  <button
                    id={`inc-${template.capacity}`}
                    onClick={() => updateCount(template.capacity, 1)}
                    className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-700 text-white transition-colors hover:bg-slate-600 sm:h-8 sm:w-8"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="mb-5 flex items-center gap-3 rounded-xl border border-indigo-500/20 bg-indigo-500/10 p-3">
            <CheckCircle2 className="h-5 w-5 flex-shrink-0 text-indigo-400" />
            <p className="text-sm text-indigo-300">
              Total: <span className="font-bold text-white">{totalTables}</span> tables configured
            </p>
          </div>

          {totalTables > 0 && (
            <div className="mb-5 rounded-xl border border-slate-700/50 bg-slate-800/60 px-3 py-2.5 text-xs text-slate-300">
              Tables are numbered sequentially as <span className="font-mono text-white">T-01</span>,{' '}
              <span className="font-mono text-white">T-02</span>, and so on so merchants and guests see the same table code.
            </div>
          )}

          {error && (
            <div className="mb-5 rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              {error}
            </div>
          )}

          <button
            id="startQueueBtn"
            onClick={handleConfirm}
            disabled={isSaving || totalTables === 0}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 to-purple-600 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-500/20 transition-all duration-200 hover:-translate-y-0.5 hover:from-indigo-500 hover:to-purple-500 hover:shadow-indigo-500/40 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isSaving ? 'Saving layout...' : 'Start Queue System'}
            {!isSaving && <ChevronRight className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}
