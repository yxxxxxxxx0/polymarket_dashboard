"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { api, profileFromPath, UI_REFRESH_MS, withProfile, type AccountSummaryResponse } from "@/lib/api";

type AccountContextValue = {
  account: AccountSummaryResponse | null;
  loading: boolean;
  error: string | null;
  refreshAccount: (options?: { force?: boolean }) => Promise<AccountSummaryResponse | null>;
};

const AccountContext = createContext<AccountContextValue | null>(null);

export function AccountProvider({ children }: { children: ReactNode }) {
  const profile = profileFromPath(usePathname());
  const [account, setAccount] = useState<AccountSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef<Promise<AccountSummaryResponse | null> | null>(null);
  const mounted = useRef(true);

  const refreshAccount = useCallback((options: { force?: boolean } = {}) => {
    if (!options.force && inFlight.current) return inFlight.current;

    inFlight.current = api<AccountSummaryResponse>(withProfile(options.force ? "/api/account?refresh=1" : "/api/account", profile))
      .then((nextAccount) => {
        if (mounted.current) {
          setAccount(nextAccount);
          setError(null);
        }
        return nextAccount;
      })
      .catch((nextError) => {
        if (mounted.current) {
          setError(nextError instanceof Error ? nextError.message : "Account unavailable");
        }
        return null;
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
        inFlight.current = null;
      });

    return inFlight.current;
  }, [profile]);

  useEffect(() => {
    mounted.current = true;
    setAccount(null);
    setLoading(true);
    refreshAccount({ force: true });
    const poll = window.setInterval(refreshAccount, UI_REFRESH_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(poll);
    };
  }, [refreshAccount]);

  const value = useMemo(() => ({
    account,
    loading,
    error,
    refreshAccount
  }), [account, error, loading, refreshAccount]);

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount() {
  const context = useContext(AccountContext);
  if (!context) throw new Error("useAccount must be used within AccountProvider");
  return context;
}
