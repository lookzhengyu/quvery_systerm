import { useState, type FormEvent } from 'react';
import {
  AlertCircle,
  Lock,
  LogIn,
  Plus,
  Sparkles,
  Store,
  UtensilsCrossed,
} from 'lucide-react';
import { useQueue } from '../../context/useQueue';
import MerchantSignupModal from './MerchantSignupModal';
import type { MerchantRegistrationInput } from '../../types';

interface LoginProps {
  onSuccess: () => void;
}

export default function Login({ onSuccess }: LoginProps) {
  const { login, registerMerchant, syncMode } = useQueue();
  const supportsProvisioning = syncMode === 'remote';
  const [storeId, setStoreId] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSignupOpen, setIsSignupOpen] = useState(false);

  const handleSignIn = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const success = await login(storeId.trim(), password);
      if (!success) {
        setError('Invalid Store ID or password. Try RESTO-001 / admin123');
        return;
      }

      onSuccess();
    } catch (loginError) {
      setError(
        loginError instanceof Error
          ? loginError.message
          : 'Unable to reach the queue server right now.'
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreateStore = async (input: MerchantRegistrationInput) => {
    setError('');
    setIsLoading(true);

    try {
      await registerMerchant(input);
      setIsSignupOpen(false);
      onSuccess();
    } catch (registerError) {
      setError(
        registerError instanceof Error
          ? registerError.message
          : 'Unable to provision your store right now.'
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-start justify-center overflow-hidden bg-slate-950 px-3 py-3 sm:px-6 sm:pb-8 sm:pt-24 lg:items-center lg:pt-20">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute left-[10%] top-[12%] h-72 w-72 rounded-full bg-indigo-600/10 blur-3xl" />
        <div className="absolute bottom-[8%] right-[8%] h-80 w-80 rounded-full bg-cyan-600/10 blur-3xl" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(99,102,241,0.12),transparent_35%),linear-gradient(to_bottom,rgba(15,23,42,0),rgba(2,6,23,0.82))]" />
      </div>

      <div className="relative w-full max-w-4xl overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/92 shadow-2xl shadow-black/30 sm:rounded-[32px]">
        <div className="grid lg:grid-cols-[340px,1fr]">
          <div className="border-b border-slate-800 bg-slate-900/80 p-4 sm:p-8 lg:border-b-0 lg:border-r">
            <div className="flex items-center gap-3 lg:block">
              <div className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-cyan-500 shadow-lg shadow-indigo-500/20 sm:h-16 sm:w-16 sm:rounded-3xl">
                <UtensilsCrossed className="h-5 w-5 text-white sm:h-8 sm:w-8" />
              </div>

              <div className="min-w-0 lg:mt-6">
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-indigo-300 sm:text-xs sm:tracking-[0.18em]">
                  Merchant Access
                </p>
                <h1 className="mt-1 text-xl font-semibold tracking-tight text-white sm:mt-3 sm:text-3xl">
                  QueueFlow Merchant
                </h1>
              </div>
            </div>

            <p className="mt-2 max-w-sm text-xs leading-5 text-slate-400 sm:mt-3 sm:text-sm sm:leading-7">
              Sign in fast and manage the live queue.
              <span className="hidden sm:inline"> Open your customer QR when you need it.</span>
            </p>

            <div className="mt-3 hidden flex-wrap gap-2 sm:flex sm:mt-6">
              {[
                'Cleaner operator workflow',
                'Unique QR per store',
                'Live multi-device sync',
              ].map(item => (
                <span
                  key={item}
                  className="rounded-full border border-slate-800 bg-slate-950/70 px-3 py-1.5 text-xs font-medium text-slate-300"
                >
                  {item}
                </span>
              ))}
            </div>

            <div className="mt-8 hidden rounded-3xl border border-indigo-500/20 bg-indigo-500/10 p-4 lg:block">
              <div className="flex items-start gap-3">
                <Sparkles className="mt-0.5 h-4 w-4 flex-shrink-0 text-indigo-300" />
                <div>
                  <p className="text-sm font-semibold text-white">Keep the first screen simple</p>
                  <p className="mt-2 text-sm leading-7 text-slate-300">
                    New store provisioning is still available, but it stays behind a secondary
                    action instead of taking over the whole page.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="p-4 sm:p-8 lg:p-10">
            <div className="mx-auto max-w-md">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500 sm:text-xs sm:tracking-[0.18em]">
                  Sign In
                </p>
                <h2 className="mt-1.5 text-xl font-semibold text-white sm:mt-3 sm:text-2xl">
                  Start with the store ID
                </h2>
                <p className="mt-1 text-xs leading-5 text-slate-400 sm:mt-2 sm:text-sm sm:leading-7">
                  Use your merchant credentials to go straight into the dashboard.
                </p>
              </div>

              {error && (
                <div className="mt-3 flex items-start gap-2 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200 sm:mt-5">
                  <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                  <p>{error}</p>
                </div>
              )}

              <form onSubmit={handleSignIn} className="mt-4 space-y-3 sm:mt-6 sm:space-y-5">
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-300 sm:mb-2">
                    Store ID
                  </label>
                  <div className="relative">
                    <Store className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                    <input
                      id="storeId"
                      type="text"
                      value={storeId}
                      onChange={event => setStoreId(event.target.value)}
                      placeholder="e.g. RESTO-001"
                      className="w-full rounded-xl border border-slate-800 bg-slate-900 px-11 py-3 text-sm text-white placeholder-slate-500 outline-none transition-all focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 sm:rounded-2xl sm:py-3.5"
                      required
                    />
                  </div>
                </div>

                <div>
                  <label className="mb-1.5 block text-sm font-medium text-slate-300 sm:mb-2">
                    Password
                  </label>
                  <div className="relative">
                    <input
                      id="password"
                      type="password"
                      value={password}
                      onChange={event => setPassword(event.target.value)}
                      placeholder="Enter password"
                      className="w-full rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 pr-11 text-sm text-white placeholder-slate-500 outline-none transition-all focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 sm:rounded-2xl sm:py-3.5"
                      required
                    />
                    <Lock className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                  </div>
                </div>

                <button
                  id="loginBtn"
                  type="submit"
                  disabled={isLoading}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 to-cyan-500 px-4 py-3 text-sm font-semibold text-white transition-all hover:-translate-y-0.5 hover:from-indigo-500 hover:to-cyan-400 disabled:cursor-not-allowed disabled:opacity-60 sm:rounded-2xl sm:py-3.5"
                >
                  {isLoading ? (
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                  ) : (
                    <LogIn className="h-4 w-4" />
                  )}
                  {isLoading ? 'Signing in...' : 'Sign In'}
                </button>
              </form>

              <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/60 px-3 py-2.5 sm:mt-5 sm:rounded-3xl sm:p-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500 sm:text-xs sm:tracking-[0.18em]">
                  Demo Merchant
                </p>
                <p className="mt-1 text-xs leading-5 text-slate-300 sm:mt-2 sm:text-sm sm:leading-7">
                  Store ID <span className="font-semibold text-indigo-300">RESTO-001</span> with
                  password <span className="font-semibold text-indigo-300">admin123</span>
                </p>
              </div>

              {supportsProvisioning && (
                <div className="mt-3 rounded-2xl border border-slate-800 bg-slate-900/45 px-3 py-2.5 sm:mt-5 sm:rounded-3xl sm:p-4">
                  <p className="text-sm font-medium text-white">Need a new merchant store?</p>
                  <p className="hidden mt-2 text-sm leading-7 text-slate-400 sm:block">
                    Create one from a secondary flow instead of loading the full setup form on the
                    first screen.
                  </p>
                  <button
                    id="openSignupBtn"
                    type="button"
                    onClick={() => {
                      setError('');
                      setIsSignupOpen(true);
                    }}
                    className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm font-semibold text-slate-200 transition-colors hover:bg-slate-800 sm:mt-4 sm:w-auto sm:rounded-2xl sm:py-3"
                  >
                    <Plus className="h-4 w-4" />
                    Create New Store
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {supportsProvisioning && isSignupOpen && (
        <MerchantSignupModal
          error={error}
          isLoading={isLoading}
          onClose={() => setIsSignupOpen(false)}
          onSubmit={handleCreateStore}
        />
      )}
    </div>
  );
}
