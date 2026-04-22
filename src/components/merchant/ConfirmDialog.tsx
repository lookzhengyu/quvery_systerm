import { X } from 'lucide-react';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'default';
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  isOpen,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!isOpen) {
    return null;
  }

  const confirmClasses =
    variant === 'danger'
      ? 'bg-rose-600 text-white hover:bg-rose-500'
      : 'bg-indigo-600 text-white hover:bg-indigo-500';

  return (
    <div className="qf-modal-backdrop fixed inset-0 z-[80] flex items-end justify-center bg-slate-950/80 p-3 backdrop-blur-sm sm:items-center sm:p-4">
      <div className="qf-dialog-panel max-h-[calc(100svh-1.5rem)] w-full max-w-sm overflow-y-auto rounded-2xl border border-slate-700/50 bg-slate-900 p-5 shadow-2xl sm:p-6">
        <div className="mb-4 flex items-start justify-between gap-3">
          <h3 className="text-base font-bold text-white">{title}</h3>
          <button
            onClick={onCancel}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-6 text-sm leading-relaxed text-slate-400">{description}</p>
        <div className="grid grid-cols-2 gap-3 sm:flex sm:items-center sm:justify-end">
          <button
            id="confirmDialogCancelBtn"
            onClick={onCancel}
            className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 text-sm font-semibold text-slate-200 transition-colors hover:bg-slate-700 sm:py-2.5"
          >
            {cancelLabel}
          </button>
          <button
            id="confirmDialogConfirmBtn"
            onClick={onConfirm}
            className={`rounded-xl px-4 py-3 text-sm font-semibold transition-all duration-200 hover:-translate-y-0.5 sm:py-2.5 ${confirmClasses}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
