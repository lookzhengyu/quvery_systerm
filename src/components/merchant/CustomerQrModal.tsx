import { useEffect, useMemo, useState } from 'react';
import {
  Copy,
  Download,
  ExternalLink,
  Globe,
  QrCode,
  Smartphone,
  Store,
  X,
} from 'lucide-react';
import QRCode from 'qrcode';
import { getCustomerPortalTarget } from '../../utils/portal';

interface CustomerQrModalProps {
  storeId: string;
  storeName: string;
  onClose: () => void;
}

export default function CustomerQrModal({
  storeId,
  storeName,
  onClose,
}: CustomerQrModalProps) {
  const customerPortalTarget = useMemo(() => getCustomerPortalTarget(storeId), [storeId]);
  const customerPortalUrl = customerPortalTarget.customerPortalUrl;
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [copyFeedback, setCopyFeedback] = useState('');
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let isActive = true;

    void QRCode.toDataURL(customerPortalUrl, {
      width: 720,
      margin: 2,
      color: {
        dark: '#0f172a',
        light: '#ffffff',
      },
    })
      .then((dataUrl: string) => {
        if (!isActive) {
          return;
        }

        setQrDataUrl(dataUrl);
        setLoadError('');
      })
      .catch(() => {
        if (isActive) {
          setLoadError('Unable to generate QR preview');
        }
      });

    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeydown);
    return () => {
      isActive = false;
      window.removeEventListener('keydown', handleKeydown);
    };
  }, [customerPortalUrl, onClose]);

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(customerPortalUrl);
      setCopyFeedback('Customer link copied.');
    } catch {
      setCopyFeedback('Unable to copy. You can still copy the link manually below.');
    }
  };

  const handleDownload = () => {
    if (!qrDataUrl) {
      return;
    }

    const link = document.createElement('a');
    link.href = qrDataUrl;
    link.download = `queueflow-${storeId.toLowerCase()}-customer-qr.png`;
    link.click();
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-stretch justify-center bg-slate-950/80 p-2 backdrop-blur-sm sm:items-center sm:p-4">
      <div className="flex max-h-[calc(100svh-1rem)] w-full max-w-[54rem] flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-2xl shadow-black/40 sm:max-h-[88vh] sm:rounded-3xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-800 px-4 py-3.5 sm:gap-4 sm:px-5">
          <div className="min-w-0 space-y-2">
            <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-300 sm:text-[11px] sm:tracking-[0.18em]">
              <QrCode className="h-3.5 w-3.5" />
              Customer Entrance QR
            </div>
            <div>
              <h2 className="break-words text-base font-semibold text-white sm:text-lg">
                Unique QR for {storeName}
              </h2>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-400">
                <span className="inline-flex items-center gap-1.5">
                  <Store className="h-4 w-4" />
                  {storeId}
                </span>
                <span className="hidden h-1 w-1 rounded-full bg-slate-700 sm:block" />
                <span className="inline-flex items-center gap-1.5">
                  <Smartphone className="h-4 w-4" />
                  Scan opens this store's customer page directly
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span
                  id="customerQrReadinessBadge"
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                    customerPortalTarget.readyForLiveCustomers
                      ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'
                      : 'border-amber-500/20 bg-amber-500/10 text-amber-200'
                  }`}
                >
                  <Globe className="h-3.5 w-3.5" />
                  {customerPortalTarget.readyForLiveCustomers ? 'Live ready' : 'Preview only'}
                </span>
                <span className="rounded-full border border-slate-800 bg-slate-900 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-300">
                  {customerPortalTarget.hostname}
                </span>
              </div>
            </div>
          </div>

          <button
            id="closeCustomerQrModalBtn"
            onClick={onClose}
            className="shrink-0 rounded-2xl border border-slate-800 bg-slate-900 p-2 text-slate-400 transition-colors hover:text-white"
            aria-label="Close customer QR"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 overflow-y-auto">
          <div className="grid gap-0 lg:grid-cols-[260px,minmax(0,1fr)]">
            <div className="border-b border-slate-800 bg-slate-900/60 p-4 lg:border-b-0 lg:border-r sm:p-5">
              <div className="mx-auto w-full max-w-[220px] rounded-[28px] border border-slate-800 bg-white p-3.5 shadow-xl shadow-black/20">
                <div className="aspect-square overflow-hidden rounded-2xl bg-white">
                  {qrDataUrl ? (
                    <img
                      src={qrDataUrl}
                      alt={`Customer QR for ${storeName}`}
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-sm text-slate-500">
                      {loadError || 'Generating QR code...'}
                    </div>
                  )}
                </div>
              </div>

              <p className="mt-3 text-xs leading-6 text-slate-400">
                Print this code and place it at the entrance, host stand, or table waiting area.
                The same QR can stay in use unless you change the app domain or the store ID.
                Customers receive a fresh short-lived entry session each time they open it.
              </p>
            </div>

            <div className="min-w-0 p-4 sm:p-5">
              {customerPortalTarget.warning && (
                <div
                  id="customerQrWarningBox"
                  className="mb-4 rounded-3xl border border-amber-500/15 bg-amber-500/5 p-3.5"
                >
                  <div className="flex items-start gap-3">
                    <Globe className="mt-0.5 h-4 w-4 text-amber-200" />
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-amber-200">
                        Launch Warning
                      </p>
                      <p className="mt-2 text-sm leading-6 text-slate-300">
                        {customerPortalTarget.warning}
                      </p>
                      {!customerPortalTarget.usesConfiguredPublicUrl && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          <span className="rounded-full border border-amber-500/20 bg-slate-950 px-2 py-1 font-mono text-[11px] text-amber-100">
                            VITE_PUBLIC_APP_URL
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              <div className="grid gap-2 sm:grid-cols-3 sm:gap-3">
                <button
                  id="copyCustomerQrLinkBtn"
                  onClick={() => {
                    void handleCopyLink();
                  }}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl border border-slate-700 bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-slate-800 sm:min-h-0"
                >
                  <Copy className="h-4 w-4" />
                  Copy Link
                </button>
                <button
                  id="downloadCustomerQrBtn"
                  onClick={handleDownload}
                  disabled={!qrDataUrl}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl border border-indigo-500/30 bg-indigo-500/15 px-4 py-2.5 text-sm font-semibold text-indigo-100 transition-colors hover:bg-indigo-500/25 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0"
                >
                  <Download className="h-4 w-4" />
                  Download PNG
                </button>
                <a
                  id="openCustomerQrLinkBtn"
                  href={customerPortalUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl border border-emerald-500/30 bg-emerald-500/15 px-4 py-2.5 text-sm font-semibold text-emerald-100 transition-colors hover:bg-emerald-500/25 sm:min-h-0"
                >
                  <ExternalLink className="h-4 w-4" />
                  Test Link
                </a>
              </div>

              {copyFeedback && (
                <div className="mt-3 rounded-2xl border border-sky-500/20 bg-sky-500/10 px-4 py-3 text-sm text-sky-200">
                  {copyFeedback}
                </div>
              )}

              <div className="mt-4 rounded-3xl border border-slate-800 bg-slate-900/60 p-3.5">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Customer Link
                </p>
                <div className="mt-3 rounded-2xl border border-slate-800 bg-slate-950 px-4 py-3">
                  <p className="break-all font-mono text-xs leading-6 text-slate-300">
                    {customerPortalUrl}
                  </p>
                </div>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <div className="rounded-3xl border border-slate-800 bg-slate-900/60 p-3.5">
                  <p className="text-sm font-semibold text-white">1. One QR per store</p>
                  <p className="mt-2 text-sm leading-6 text-slate-400">
                    This QR is tied to{' '}
                    <span className="font-medium text-slate-200">{storeId}</span>, so every
                    merchant gets their own entrance link.
                  </p>
                </div>
                <div className="rounded-3xl border border-slate-800 bg-slate-900/60 p-3.5">
                  <p className="text-sm font-semibold text-white">2. Customer-only entry</p>
                  <p className="mt-2 text-sm leading-6 text-slate-400">
                    The link forces the app into the customer portal instead of landing on the
                    merchant dashboard.
                  </p>
                </div>
                <div className="rounded-3xl border border-slate-800 bg-slate-900/60 p-3.5">
                  <p className="text-sm font-semibold text-white">
                    {customerPortalTarget.readyForLiveCustomers
                      ? '3. Ready for sticker print'
                      : !customerPortalTarget.usesConfiguredPublicUrl
                        ? '3. Set public app URL'
                        : customerPortalTarget.usesPrivateOrLocalHost
                          ? '3. Local preview only'
                          : '3. Enable HTTPS'}
                  </p>
                  <p className="mt-2 text-sm leading-6 text-slate-400">
                    {customerPortalTarget.readyForLiveCustomers
                      ? 'Download the PNG and use it for a door sticker, tabletop card, or cashier sign.'
                      : customerPortalTarget.warning}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
