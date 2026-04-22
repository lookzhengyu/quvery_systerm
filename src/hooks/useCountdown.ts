import { useEffect, useRef, useState } from 'react';

const COUNTDOWN_SECONDS = 60;

interface UseCountdownResult {
  secondsRemaining: number;
  isExpired: boolean;
  progress: number;
}

export function useCountdown(
  callTime: Date | undefined,
  onExpire?: () => void
): UseCountdownResult {
  const [currentTime, setCurrentTime] = useState<number | null>(null);
  const onExpireRef = useRef(onExpire);
  const hasExpiredRef = useRef(false);

  useEffect(() => {
    onExpireRef.current = onExpire;
  }, [onExpire]);

  useEffect(() => {
    if (!callTime) {
      hasExpiredRef.current = false;
      return undefined;
    }

    hasExpiredRef.current = false;
    const syncTimer = window.setTimeout(() => {
      setCurrentTime(Date.now());
    }, 0);
    const interval = window.setInterval(() => {
      setCurrentTime(Date.now());
    }, 1000);

    return () => {
      window.clearTimeout(syncTimer);
      window.clearInterval(interval);
    };
  }, [callTime]);

  const effectiveNow = currentTime ?? callTime?.getTime() ?? 0;
  const secondsRemaining = callTime
    ? Math.max(0, COUNTDOWN_SECONDS - Math.floor((effectiveNow - callTime.getTime()) / 1000))
    : COUNTDOWN_SECONDS;
  const isExpired = Boolean(callTime) && secondsRemaining === 0;

  useEffect(() => {
    if (!isExpired || hasExpiredRef.current) {
      return;
    }

    hasExpiredRef.current = true;
    onExpireRef.current?.();
  }, [isExpired]);

  return {
    secondsRemaining,
    isExpired,
    progress: (secondsRemaining / COUNTDOWN_SECONDS) * 100,
  };
}
