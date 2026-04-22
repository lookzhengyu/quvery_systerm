import { useState, type FormEvent } from 'react';
import { CreditCard, Lock, Mail, Phone, Store, UserRound, X } from 'lucide-react';
import type { MerchantPlanCode, MerchantRegistrationInput } from '../../types';

interface MerchantSignupModalProps {
  error: string;
  isLoading: boolean;
  onClose: () => void;
  onSubmit: (input: MerchantRegistrationInput) => Promise<void>;
}

const PLAN_OPTIONS: Array<{
  code: MerchantPlanCode;
  name: string;
  description: string;
}> = [
  {
    code: 'starter',
    name: 'Starter',
    description: 'Lean setup for smaller dining rooms.',
  },
  {
    code: 'growth',
    name: 'Growth',
    description: 'Best balance for most restaurants.',
  },
  {
    code: 'scale',
    name: 'Scale',
    description: 'Built for heavier multi-device operations.',
  },
];

export default function MerchantSignupModal({
  error,
  isLoading,
  onClose,
  onSubmit,
}: MerchantSignupModalProps) {
  const [storeName, setStoreName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [planCode, setPlanCode] = useState<MerchantPlanCode>('growth');
  const [formError, setFormError] = useState('');

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setFormError('');

    if (password.length < 8) {
      setFormError('Password must be at least 8 characters.');
      return;
    }

    if (password !== confirmPassword) {
      setFormError('Passwords do not match.');
      return;
    }

    await onSubmit({
      storeName: storeName.trim(),
      ownerName: ownerName.trim(),
      ownerEmail: ownerEmail.trim().toLowerCase(),
      contactPhone: contactPhone.trim(),
      password,
      planCode,
      billingCycle: 'monthly',
    });
  };

  return (
    <div className="fixed inset-0 z-[72] flex items-stretch justify-center bg-slate-950/85 p-2 backdrop-blur-sm sm:items-center sm:p-4">
      <div className="flex max-h-[calc(100svh-1rem)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-2xl shadow-black/40 sm:rounded-[32px]">
        <div className="flex items-start justify-between gap-3 border-b border-slate-800 px-4 py-4 sm:gap-4 sm:px-6">
          <div className="min-w-0">
            <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-300 sm:text-[11px] sm:tracking-[0.18em]">
              <Store className="h-3.5 w-3.5" />
              Create Store
            </div>
            <h2 className="mt-3 text-base font-semibold text-white sm:text-lg">
              Open a new merchant workspace
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-400 sm:leading-7">
              We will provision your store ID, merchant access, and customer QR after
              submission.
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-2xl border border-slate-800 bg-slate-900 p-2 text-slate-400 transition-colors hover:text-white"
            aria-label="Close merchant signup"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="grid min-h-0 gap-5 overflow-y-auto p-4 sm:p-6">
          <div className="grid gap-5 md:grid-cols-2">
            <div className="md:col-span-2">
              <label className="mb-2 block text-sm font-medium text-slate-300">
                Restaurant name
              </label>
              <div className="relative">
                <Store className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  type="text"
                  value={storeName}
                  onChange={event => setStoreName(event.target.value)}
                  placeholder="The Grand Table"
                  className="w-full rounded-2xl border border-slate-800 bg-slate-900 px-11 py-3.5 text-sm text-white placeholder-slate-500 outline-none transition-all focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30"
                  required
                />
              </div>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-300">
                Owner name
              </label>
              <div className="relative">
                <UserRound className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  type="text"
                  value={ownerName}
                  onChange={event => setOwnerName(event.target.value)}
                  placeholder="Alicia Tan"
                  className="w-full rounded-2xl border border-slate-800 bg-slate-900 px-11 py-3.5 text-sm text-white placeholder-slate-500 outline-none transition-all focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30"
                  required
                />
              </div>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-300">
                Owner email
              </label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  type="email"
                  value={ownerEmail}
                  onChange={event => setOwnerEmail(event.target.value)}
                  placeholder="owner@restaurant.com"
                  className="w-full rounded-2xl border border-slate-800 bg-slate-900 px-11 py-3.5 text-sm text-white placeholder-slate-500 outline-none transition-all focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30"
                  required
                />
              </div>
            </div>

            <div className="md:col-span-2">
              <label className="mb-2 block text-sm font-medium text-slate-300">
                Contact phone <span className="text-slate-500">(optional)</span>
              </label>
              <div className="relative">
                <Phone className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  type="tel"
                  value={contactPhone}
                  onChange={event => setContactPhone(event.target.value)}
                  placeholder="+60 12-345 6789"
                  className="w-full rounded-2xl border border-slate-800 bg-slate-900 px-11 py-3.5 text-sm text-white placeholder-slate-500 outline-none transition-all focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30"
                />
              </div>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-300">
                Login password
              </label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  type="password"
                  value={password}
                  onChange={event => setPassword(event.target.value)}
                  placeholder="At least 8 characters"
                  className="w-full rounded-2xl border border-slate-800 bg-slate-900 px-11 py-3.5 text-sm text-white placeholder-slate-500 outline-none transition-all focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30"
                  required
                  minLength={8}
                />
              </div>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-300">
                Confirm password
              </label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={event => setConfirmPassword(event.target.value)}
                  placeholder="Re-enter password"
                  className="w-full rounded-2xl border border-slate-800 bg-slate-900 px-11 py-3.5 text-sm text-white placeholder-slate-500 outline-none transition-all focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30"
                  required
                  minLength={8}
                />
              </div>
            </div>
          </div>

          <div>
            <div className="mb-3 flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-slate-500" />
              <p className="text-sm font-medium text-slate-300">Launch plan</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {PLAN_OPTIONS.map(plan => (
                <button
                  key={plan.code}
                  type="button"
                  onClick={() => setPlanCode(plan.code)}
                  className={`rounded-2xl border p-4 text-left transition-all sm:rounded-3xl ${
                    planCode === plan.code
                      ? 'border-indigo-500 bg-indigo-500/10 shadow-lg shadow-indigo-500/10'
                      : 'border-slate-800 bg-slate-900/70 hover:border-slate-700'
                  }`}
                >
                  <p className="text-sm font-semibold text-white">{plan.name}</p>
                  <p className="mt-2 text-sm leading-6 text-slate-400">
                    {plan.description}
                  </p>
                </button>
              ))}
            </div>
          </div>

          {(formError || error) && (
            <div className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
              {formError || error}
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:flex sm:flex-wrap sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm font-semibold text-slate-200 transition-colors hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading}
              className="rounded-2xl bg-gradient-to-r from-indigo-600 to-cyan-500 px-4 py-3 text-sm font-semibold text-white transition-all hover:-translate-y-0.5 hover:from-indigo-500 hover:to-cyan-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isLoading ? 'Provisioning...' : 'Create Store'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
