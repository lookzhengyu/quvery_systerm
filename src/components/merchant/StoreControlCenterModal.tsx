import { useEffect, useState } from 'react';
import {
  BadgeCheck,
  Copy,
  CreditCard,
  Globe,
  Lock,
  Mail,
  Phone,
  QrCode,
  Save,
  Store,
  UserRound,
  X,
} from 'lucide-react';
import type { MerchantPlanCode, MerchantProfile, MerchantProvisioning } from '../../types';
import { buildCustomerPortalUrl, getCustomerPortalTarget } from '../../utils/portal';

interface StoreControlCenterModalProps {
  isOpen: boolean;
  profile: MerchantProfile;
  provisioning: MerchantProvisioning | null;
  onClose: () => void;
  onSave: (input: {
    storeName: string;
    ownerName: string;
    ownerEmail: string;
    contactPhone: string;
    planCode: MerchantPlanCode;
  }) => Promise<void>;
  onChangePassword: (input: {
    currentPassword: string;
    nextPassword: string;
  }) => Promise<void>;
  onOpenQr: () => void;
  onStartSubscription: (planCode: MerchantPlanCode) => Promise<void>;
  onOpenBillingPortal: () => Promise<void>;
  onSendTestNotification: (recipient?: string) => Promise<void>;
}

const PLAN_LABELS: Record<MerchantPlanCode, string> = {
  starter: 'Starter',
  growth: 'Growth',
  scale: 'Scale',
};

const STATUS_STYLES = {
  trialing: 'border-amber-500/20 bg-amber-500/10 text-amber-200',
  active: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200',
  past_due: 'border-rose-500/20 bg-rose-500/10 text-rose-200',
  inactive: 'border-slate-700 bg-slate-800 text-slate-200',
} as const;

function formatDate(value: string | null): string {
  if (!value) {
    return 'Not set';
  }

  try {
    return new Date(value).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return value;
  }
}

function formatMoney(currency: string, amount: number): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
      maximumFractionDigits: 2,
    }).format(amount / 100);
  } catch {
    return `${currency.toUpperCase()} ${(amount / 100).toFixed(2)}`;
  }
}

function IntegrationStatus({
  ready,
  readyLabel = 'Ready',
  pendingLabel = 'Setup needed',
}: {
  ready: boolean;
  readyLabel?: string;
  pendingLabel?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
        ready
          ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'
          : 'border-amber-500/20 bg-amber-500/10 text-amber-200'
      }`}
    >
      {ready ? readyLabel : pendingLabel}
    </span>
  );
}

export default function StoreControlCenterModal({
  isOpen,
  profile,
  provisioning,
  onClose,
  onSave,
  onChangePassword,
  onOpenQr,
  onStartSubscription,
  onOpenBillingPortal,
  onSendTestNotification,
}: StoreControlCenterModalProps) {
  const [storeName, setStoreName] = useState(profile.storeName);
  const [ownerName, setOwnerName] = useState(profile.ownerName);
  const [ownerEmail, setOwnerEmail] = useState(profile.ownerEmail);
  const [contactPhone, setContactPhone] = useState(profile.contactPhone);
  const [planCode, setPlanCode] = useState<MerchantPlanCode>(profile.planCode);
  const [error, setError] = useState('');
  const [saveFeedback, setSaveFeedback] = useState('');
  const [billingFeedback, setBillingFeedback] = useState('');
  const [notificationFeedback, setNotificationFeedback] = useState('');
  const [passwordFeedback, setPasswordFeedback] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [isLaunchingBilling, setIsLaunchingBilling] = useState(false);
  const [isSendingTestNotification, setIsSendingTestNotification] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setStoreName(profile.storeName);
    setOwnerName(profile.ownerName);
    setOwnerEmail(profile.ownerEmail);
    setContactPhone(profile.contactPhone);
    setPlanCode(profile.planCode);
    setError('');
    setSaveFeedback('');
    setBillingFeedback('');
    setNotificationFeedback('');
    setPasswordFeedback('');
    setCurrentPassword('');
    setNextPassword('');
    setConfirmPassword('');
  }, [isOpen, profile]);

  if (!isOpen) {
    return null;
  }

  const portalUrl = buildCustomerPortalUrl(profile.storeId);
  const customerPortalTarget = getCustomerPortalTarget(profile.storeId);
  const subscriptionStatusClasses =
    STATUS_STYLES[profile.subscriptionStatus] ?? STATUS_STYLES.inactive;
  const selectedPlan = profile.billing.plans[planCode] ?? profile.billing.plans[profile.planCode];
  const planPriceLabel = selectedPlan
    ? `${formatMoney(selectedPlan.currency, selectedPlan.amount)}/${selectedPlan.interval}`
    : 'Not configured';
  const billingSummary = !profile.billing.checkoutEnabled
    ? 'Stripe setup needed'
    : profile.billing.portalEnabled
      ? 'Checkout and portal ready'
      : 'Checkout ready';
  const customerEntrySummary = customerPortalTarget.readyForLiveCustomers
    ? 'Live link ready'
    : customerPortalTarget.usesPrivateOrLocalHost
      ? 'Local preview only'
      : 'Public app URL needed';
  const notificationsSummary = profile.notifications.deliveryEnabled
    ? 'Email delivery enabled'
    : 'Email setup needed';

  const handleSubmit = async () => {
    setError('');
    setSaveFeedback('');
    setBillingFeedback('');
    setNotificationFeedback('');
    setPasswordFeedback('');
    setIsSaving(true);

    try {
      await onSave({
        storeName,
        ownerName,
        ownerEmail,
        contactPhone,
        planCode,
      });
      setSaveFeedback('Store settings saved.');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Unable to save store settings.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleChangePassword = async () => {
    setError('');
    setSaveFeedback('');
    setBillingFeedback('');
    setNotificationFeedback('');
    setPasswordFeedback('');

    if (nextPassword.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }

    if (nextPassword !== confirmPassword) {
      setError('New password and confirmation do not match.');
      return;
    }

    setIsChangingPassword(true);

    try {
      await onChangePassword({
        currentPassword,
        nextPassword,
      });
      setCurrentPassword('');
      setNextPassword('');
      setConfirmPassword('');
      setPasswordFeedback('Login password updated.');
    } catch (passwordError) {
      setError(
        passwordError instanceof Error ? passwordError.message : 'Unable to update login password.'
      );
    } finally {
      setIsChangingPassword(false);
    }
  };

  const handleStartSubscription = async () => {
    setError('');
    setSaveFeedback('');
    setBillingFeedback('');
    setNotificationFeedback('');
    setPasswordFeedback('');
    setIsLaunchingBilling(true);

    try {
      await onStartSubscription(planCode);
      setBillingFeedback('Redirecting to Stripe checkout...');
    } catch (billingError) {
      setError(
        billingError instanceof Error
          ? billingError.message
          : 'Unable to open Stripe checkout right now.'
      );
    } finally {
      setIsLaunchingBilling(false);
    }
  };

  const handleOpenBillingPortal = async () => {
    setError('');
    setSaveFeedback('');
    setBillingFeedback('');
    setNotificationFeedback('');
    setPasswordFeedback('');
    setIsLaunchingBilling(true);

    try {
      await onOpenBillingPortal();
      setBillingFeedback('Redirecting to Stripe billing portal...');
    } catch (billingError) {
      setError(
        billingError instanceof Error
          ? billingError.message
          : 'Unable to open Stripe billing portal right now.'
      );
    } finally {
      setIsLaunchingBilling(false);
    }
  };

  const handleSendTestNotification = async () => {
    setError('');
    setSaveFeedback('');
    setBillingFeedback('');
    setNotificationFeedback('');
    setPasswordFeedback('');
    setIsSendingTestNotification(true);

    try {
      await onSendTestNotification(ownerEmail);
      setNotificationFeedback(`Test email sent to ${ownerEmail}.`);
    } catch (notificationError) {
      setError(
        notificationError instanceof Error
          ? notificationError.message
          : 'Unable to send the test email right now.'
      );
    } finally {
      setIsSendingTestNotification(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[72] flex items-stretch justify-center bg-slate-950/85 p-2 backdrop-blur-sm sm:items-center sm:p-4">
      <div className="flex max-h-[calc(100svh-1rem)] w-full max-w-[50rem] flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-2xl shadow-black/40 sm:max-h-[88vh] sm:rounded-[32px]">
        <div className="flex items-start justify-between gap-3 border-b border-slate-800 px-4 py-3.5 sm:gap-4 sm:px-5">
          <div className="min-w-0">
            <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-cyan-500/20 bg-cyan-500/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-cyan-300 sm:text-[11px] sm:tracking-[0.18em]">
              <BadgeCheck className="h-3.5 w-3.5" />
              Store Control Center
            </div>
            <h2 className="mt-3 break-words text-base font-semibold text-white sm:text-lg">
              {profile.storeName}
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-400">
              <span>{profile.storeId}</span>
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${subscriptionStatusClasses}`}
              >
                {profile.subscriptionStatus.replace('_', ' ')}
              </span>
              <span className="rounded-full border border-slate-800 bg-slate-900 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-slate-300">
                {PLAN_LABELS[planCode] ?? planCode}
              </span>
            </div>
          </div>

          <button
            id="closeStoreControlBtn"
            onClick={onClose}
            className="shrink-0 rounded-2xl border border-slate-800 bg-slate-900 p-2 text-slate-400 transition-colors hover:text-white"
            aria-label="Close store control center"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 overflow-y-auto p-3 sm:p-5">
          <div className="space-y-5">
            <section className="rounded-2xl border border-slate-800 bg-slate-900/35 sm:rounded-3xl">
              <div className="grid gap-0 md:grid-cols-3">
                <div className="px-4 py-4 md:border-r md:border-slate-800">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Billing
                      </p>
                      <p className="mt-2 text-sm font-semibold text-white">{billingSummary}</p>
                    </div>
                    <IntegrationStatus ready={profile.billing.config.configured} />
                  </div>
                  <p className="mt-2 text-xs text-slate-400">
                    {PLAN_LABELS[planCode]} / {planPriceLabel}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    {formatDate(profile.billing.currentPeriodEnd ?? profile.trialEndsAt)}
                  </p>
                  {!profile.billing.config.configured && (
                    <p className="mt-2 text-xs text-amber-200">
                      Missing: {profile.billing.config.missingEnv.join(', ')}
                    </p>
                  )}
                </div>

                <div className="border-t border-slate-800 px-4 py-4 md:border-r md:border-t-0 md:border-slate-800">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Customer Entry
                      </p>
                      <p className="mt-2 text-sm font-semibold text-white">
                        {customerEntrySummary}
                      </p>
                    </div>
                    <IntegrationStatus
                      ready={customerPortalTarget.readyForLiveCustomers}
                      readyLabel="Ready"
                      pendingLabel={
                        customerPortalTarget.usesPrivateOrLocalHost ? 'Local only' : 'Setup needed'
                      }
                    />
                  </div>
                  <p className="mt-2 text-xs text-slate-400">{customerPortalTarget.hostname}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {customerPortalTarget.usesConfiguredPublicUrl
                      ? 'Using public app URL'
                      : 'Using browser fallback'}
                  </p>
                  {!customerPortalTarget.usesConfiguredPublicUrl && (
                    <p className="mt-2 text-xs text-amber-200">Missing: VITE_PUBLIC_APP_URL</p>
                  )}
                </div>

                <div className="border-t border-slate-800 px-4 py-4 md:border-t-0">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                        Notifications
                      </p>
                      <p className="mt-2 text-sm font-semibold text-white">
                        {notificationsSummary}
                      </p>
                    </div>
                    <IntegrationStatus ready={profile.notifications.deliveryEnabled} />
                  </div>
                  <p className="mt-2 text-xs text-slate-400">{profile.notifications.provider}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {profile.notifications.fromAddress ?? 'No sender configured yet'}
                  </p>
                  {!profile.notifications.deliveryEnabled && (
                    <p className="mt-2 text-xs text-amber-200">
                      Missing: {profile.notifications.config.missingEnv.join(', ')}
                    </p>
                  )}
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-slate-800 bg-slate-900/35 p-3 sm:rounded-3xl sm:p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Quick Actions
                  </p>
                  <p className="mt-1 text-sm text-slate-400">
                    Billing, QR, and notifications in one place.
                  </p>
                </div>
                {provisioning && (
                  <span className="rounded-full border border-indigo-500/20 bg-indigo-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-indigo-200">
                    New credentials ready
                  </span>
                )}
              </div>

              <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <button
                  id="startSubscriptionBtn"
                  type="button"
                  onClick={() => {
                    void handleStartSubscription();
                  }}
                  disabled={!profile.billing.checkoutEnabled || isLaunchingBilling}
                  className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl bg-cyan-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition-colors hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-0"
                >
                  <CreditCard className="h-4 w-4" />
                  {isLaunchingBilling ? 'Opening Checkout...' : `Subscribe ${PLAN_LABELS[planCode]}`}
                </button>
                <button
                  id="openBillingPortalBtn"
                  type="button"
                  onClick={() => {
                    void handleOpenBillingPortal();
                  }}
                  disabled={!profile.billing.portalEnabled || isLaunchingBilling}
                  className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm font-semibold text-slate-200 transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-0"
                >
                  <CreditCard className="h-4 w-4" />
                  Manage Billing
                </button>
                <button
                  id="openQrFromControlBtn"
                  onClick={onOpenQr}
                  className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-2.5 text-sm font-semibold text-emerald-100 transition-colors hover:bg-emerald-500/20 sm:min-h-0"
                >
                  <QrCode className="h-4 w-4" />
                  Open Customer QR
                </button>
                <button
                  id="copyCustomerLinkFromControlBtn"
                  onClick={() => {
                    void navigator.clipboard.writeText(portalUrl);
                  }}
                  className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm font-semibold text-slate-200 transition-colors hover:bg-slate-800 sm:min-h-0"
                >
                  <Copy className="h-4 w-4" />
                  Copy Customer Link
                </button>
                <button
                  id="sendTestNotificationBtn"
                  type="button"
                  onClick={() => {
                    void handleSendTestNotification();
                  }}
                  disabled={!profile.notifications.deliveryEnabled || isSendingTestNotification}
                  className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm font-semibold text-slate-200 transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60 sm:col-span-2 sm:min-h-0 lg:col-span-1"
                >
                  <Mail className="h-4 w-4" />
                  {!profile.notifications.deliveryEnabled
                    ? 'Email Setup Required'
                    : isSendingTestNotification
                      ? 'Sending Test Email...'
                      : 'Send Test Email'}
                </button>
              </div>

              <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-950/70 px-3 py-3">
                <div className="flex items-center gap-2 text-slate-300">
                  <Globe className="h-4 w-4 text-slate-500" />
                  <p className="text-sm font-semibold">Customer Link</p>
                </div>
                <p className="mt-2 break-all font-mono text-xs leading-6 text-slate-400">
                  {portalUrl}
                </p>
              </div>

              {provisioning && (
                <div className="mt-4 grid gap-2 rounded-2xl border border-indigo-500/15 bg-indigo-500/5 px-3 py-3 text-sm text-slate-200 sm:grid-cols-2">
                  <p>
                    Store ID: <span className="font-semibold">{provisioning.storeId}</span>
                  </p>
                  <p>
                    Login Password:{' '}
                    <span className="font-semibold">{provisioning.temporaryPassword}</span>
                  </p>
                </div>
              )}
            </section>

            <section className="rounded-2xl border border-slate-800 bg-slate-900/35 p-3 sm:rounded-3xl sm:p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Store Details
                  </p>
                  <p className="mt-1 text-sm text-slate-400">
                    Edit the main store profile and plan.
                  </p>
                </div>
                <span className="rounded-full border border-slate-800 bg-slate-950 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-300">
                  {profile.storeId}
                </span>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Restaurant Name
                  </label>
                  <div className="relative">
                    <Store className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                    <input
                      id="controlStoreName"
                      type="text"
                      value={storeName}
                      onChange={event => setStoreName(event.target.value)}
                      className="w-full rounded-2xl border border-slate-800 bg-slate-900 px-11 py-3 text-sm text-white outline-none transition-all focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/30"
                    />
                  </div>
                </div>

                <div>
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Owner Name
                  </label>
                  <div className="relative">
                    <UserRound className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                    <input
                      id="controlOwnerName"
                      type="text"
                      value={ownerName}
                      onChange={event => setOwnerName(event.target.value)}
                      className="w-full rounded-2xl border border-slate-800 bg-slate-900 px-11 py-3 text-sm text-white outline-none transition-all focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/30"
                    />
                  </div>
                </div>

                <div>
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Owner Email
                  </label>
                  <div className="relative">
                    <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                    <input
                      id="controlOwnerEmail"
                      type="email"
                      value={ownerEmail}
                      onChange={event => setOwnerEmail(event.target.value)}
                      className="w-full rounded-2xl border border-slate-800 bg-slate-900 px-11 py-3 text-sm text-white outline-none transition-all focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/30"
                    />
                  </div>
                </div>

                <div>
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Contact Phone
                  </label>
                  <div className="relative">
                    <Phone className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                    <input
                      id="controlContactPhone"
                      type="tel"
                      value={contactPhone}
                      onChange={event => setContactPhone(event.target.value)}
                      className="w-full rounded-2xl border border-slate-800 bg-slate-900 px-11 py-3 text-sm text-white outline-none transition-all focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/30"
                    />
                  </div>
                </div>

                <div className="sm:col-span-2">
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Launch Plan
                  </label>
                  <div className="grid grid-cols-1 gap-2 min-[380px]:grid-cols-3">
                    {(['starter', 'growth', 'scale'] as MerchantPlanCode[]).map(plan => (
                      <button
                        key={plan}
                        type="button"
                        onClick={() => setPlanCode(plan)}
                        className={`rounded-2xl border px-3 py-2.5 text-sm font-semibold transition-all ${
                          planCode === plan
                            ? 'border-cyan-500 bg-cyan-500/10 text-cyan-100'
                            : 'border-slate-800 bg-slate-900 text-slate-300 hover:bg-slate-800'
                        }`}
                      >
                        {PLAN_LABELS[plan]}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-slate-800 bg-slate-900/35 p-3 sm:rounded-3xl sm:p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Login Password
                  </p>
                  <p className="mt-1 text-sm text-slate-400">
                    Change the password for this store ID.
                  </p>
                </div>
                <Lock className="h-4 w-4 text-slate-500" />
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <div>
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Current
                  </label>
                  <input
                    id="controlCurrentPassword"
                    type="password"
                    value={currentPassword}
                    onChange={event => setCurrentPassword(event.target.value)}
                    className="w-full rounded-2xl border border-slate-800 bg-slate-900 px-4 py-3 text-sm text-white outline-none transition-all focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/30"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    New
                  </label>
                  <input
                    id="controlNewPassword"
                    type="password"
                    value={nextPassword}
                    onChange={event => setNextPassword(event.target.value)}
                    className="w-full rounded-2xl border border-slate-800 bg-slate-900 px-4 py-3 text-sm text-white outline-none transition-all focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/30"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    Confirm
                  </label>
                  <input
                    id="controlConfirmPassword"
                    type="password"
                    value={confirmPassword}
                    onChange={event => setConfirmPassword(event.target.value)}
                    className="w-full rounded-2xl border border-slate-800 bg-slate-900 px-4 py-3 text-sm text-white outline-none transition-all focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/30"
                  />
                </div>
              </div>

              <div className="mt-4 flex justify-end">
                <button
                  id="changePasswordBtn"
                  type="button"
                  onClick={() => {
                    void handleChangePassword();
                  }}
                  disabled={isChangingPassword}
                  className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm font-semibold text-slate-200 transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-0 sm:w-auto"
                >
                  <Lock className="h-4 w-4" />
                  {isChangingPassword ? 'Updating...' : 'Update Password'}
                </button>
              </div>
            </section>

            {error && (
              <div className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                {error}
              </div>
            )}

            {saveFeedback && (
              <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
                {saveFeedback}
              </div>
            )}

            {billingFeedback && (
              <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-100">
                {billingFeedback}
              </div>
            )}

            {notificationFeedback && (
              <div className="rounded-2xl border border-indigo-500/20 bg-indigo-500/10 px-4 py-3 text-sm text-indigo-100">
                {notificationFeedback}
              </div>
            )}

            {passwordFeedback && (
              <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
                {passwordFeedback}
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 sm:flex sm:flex-wrap sm:justify-end">
              <button
                id="cancelStoreControlBtn"
                type="button"
                onClick={onClose}
                className="rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm font-semibold text-slate-200 transition-colors hover:bg-slate-800 sm:py-2.5"
              >
                Close
              </button>
              <button
                id="saveStoreControlBtn"
                type="button"
                onClick={() => {
                  void handleSubmit();
                }}
                disabled={isSaving}
                className="inline-flex items-center justify-center gap-2 rounded-2xl bg-cyan-500 px-4 py-3 text-sm font-semibold text-slate-950 transition-colors hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-60 sm:py-2.5"
              >
                <Save className="h-4 w-4" />
                {isSaving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
