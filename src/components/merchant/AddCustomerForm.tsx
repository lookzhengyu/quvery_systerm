import { useState, type FormEvent } from 'react';
import { AlertCircle, Phone, Plus, UserRound, Users } from 'lucide-react';
import { useQueue } from '../../context/useQueue';

const QUICK_SIZES = [1, 2, 3, 4, 5, 6];
type EntryMode = 'phone' | 'walk-in';

export default function AddCustomerForm() {
  const { addCustomer, addWalkInCustomer } = useQueue();
  const [mode, setMode] = useState<EntryMode>('phone');
  const [phone, setPhone] = useState('');
  const [walkInName, setWalkInName] = useState('');
  const [partySize, setPartySize] = useState(2);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setSuccessMessage('');

    if (mode === 'phone') {
      const cleanedPhone = phone.replace(/\D/g, '');
      if (cleanedPhone.length < 8) {
        setError('Phone must be at least 8 digits.');
        return;
      }
    }

    setIsLoading(true);

    try {
      const result =
        mode === 'walk-in'
          ? await addWalkInCustomer(partySize, walkInName)
          : await addCustomer(phone.replace(/\D/g, ''), partySize);
      const customer = result.customer;

      if (!customer) {
        setError('Unable to add customer right now.');
        return;
      }

      if (mode === 'phone' && result.recovered) {
        setSuccessMessage(`Already in queue - #${customer.queueNumber}`);
      } else if (mode === 'walk-in') {
        setSuccessMessage(`Walk-in #${customer.queueNumber} added (${partySize}p)`);
      } else {
        setSuccessMessage(`Added #${customer.queueNumber} (${partySize}p)`);
      }

      setPhone('');
      setWalkInName('');
    } catch {
      setError('Unable to add customer right now.');
    } finally {
      setIsLoading(false);

      setTimeout(() => {
        setSuccessMessage('');
      }, 3000);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-md border border-dashed border-slate-700/60 bg-slate-800/30 px-2.5 py-2 sm:px-2 sm:py-1.5"
    >
      <div className="mb-2 flex items-center gap-1 sm:mb-1">
        <button
          type="button"
          onClick={() => setMode('phone')}
          className={`min-h-8 rounded px-3 py-1 text-[10px] font-semibold transition-all sm:min-h-0 sm:px-2 sm:py-0.5 sm:text-[9px] ${
            mode === 'phone'
              ? 'bg-indigo-600 text-white'
              : 'bg-slate-700/60 text-slate-400 active:bg-slate-700'
          }`}
        >
          Phone
        </button>
        <button
          type="button"
          onClick={() => setMode('walk-in')}
          className={`min-h-8 rounded px-3 py-1 text-[10px] font-semibold transition-all sm:min-h-0 sm:px-2 sm:py-0.5 sm:text-[9px] ${
            mode === 'walk-in'
              ? 'bg-emerald-600 text-white'
              : 'bg-slate-700/60 text-slate-400 active:bg-slate-700'
          }`}
        >
          Walk-in
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Plus className="hidden h-3 w-3 flex-shrink-0 text-indigo-400 sm:block" />
        <div className="relative min-w-[10rem] flex-1 basis-full sm:basis-0">
          {mode === 'walk-in' ? (
            <UserRound className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-500" />
          ) : (
            <Phone className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-500" />
          )}
          <input
            id={mode === 'walk-in' ? 'merchantWalkInName' : 'merchantAddPhone'}
            type={mode === 'walk-in' ? 'text' : 'tel'}
            value={mode === 'walk-in' ? walkInName : phone}
            onChange={event =>
              mode === 'walk-in'
                ? setWalkInName(event.target.value)
                : setPhone(event.target.value)
            }
            placeholder={mode === 'walk-in' ? 'Name (optional)' : 'Phone'}
            className="w-full rounded border border-slate-700 bg-slate-900 py-2 pl-6 pr-2 text-[12px] text-white placeholder-slate-500 outline-none transition focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/30 sm:py-1 sm:text-[11px]"
            required={mode === 'phone'}
          />
        </div>

        <div className="flex w-full flex-wrap items-center gap-1 sm:w-auto sm:gap-0.5">
          <Users className="h-2.5 w-2.5 flex-shrink-0 text-slate-500" />
          {QUICK_SIZES.map(size => (
            <button
              key={size}
              type="button"
              onClick={() => setPartySize(size)}
              className={`flex h-8 w-8 items-center justify-center rounded text-[10px] font-semibold transition-all sm:h-5 sm:w-5 sm:text-[9px] ${
                partySize === size
                  ? mode === 'walk-in'
                    ? 'bg-emerald-600 text-white shadow'
                    : 'bg-indigo-600 text-white shadow'
                  : 'bg-slate-700/60 text-slate-400 active:bg-slate-700 active:text-white'
              }`}
            >
              {size}
            </button>
          ))}
        </div>

        <button
          id={mode === 'walk-in' ? 'merchantAddWalkInBtn' : 'merchantAddCustomerBtn'}
          type="submit"
          disabled={isLoading}
          className={`flex min-h-9 flex-1 items-center justify-center gap-1 rounded px-3 py-1.5 text-[11px] font-semibold text-white shadow transition-all disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:flex-none sm:px-2 sm:py-1 sm:text-[10px] ${
            mode === 'walk-in'
              ? 'bg-emerald-600 active:bg-emerald-500'
              : 'bg-indigo-600 active:bg-indigo-500'
          }`}
        >
          <Plus className="h-3 w-3" />
          {mode === 'walk-in' ? 'Walk-in' : 'Add'}
        </button>
      </div>

      {mode === 'walk-in' && (
        <div className="mt-1 text-[10px] text-slate-500">
          Fast entry for no-phone customers. Queue number is generated automatically.
        </div>
      )}

      {error && (
        <div className="mt-1 flex items-center gap-1 text-[10px] text-rose-300 animate-fade-in">
          <AlertCircle className="h-2.5 w-2.5" />
          {error}
        </div>
      )}

      {successMessage && (
        <div className="mt-1 text-[10px] font-medium text-emerald-400 animate-fade-in">
          {successMessage}
        </div>
      )}
    </form>
  );
}
