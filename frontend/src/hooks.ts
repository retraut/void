import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { SessionUser } from "./types";

/**
 * Owns the current session user. The route guard redirects unauthenticated
 * visitors to the landing page when the API
 * returns 401, and exposes a logout that clears the session.
 */
export function useAuth() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { user } = await api.me();
      setUser(user);
      setError(null);
    } catch (e: any) {
      if (e?.status === 401) {
        setUser(null);
      } else {
        setError(e?.message || "auth error");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, []);

  return { user, loading, error, reload: load, logout };
}

/**
 * Polls an async getter on an interval. Pauses when the tab is hidden.
 * Returns the latest data, loading + error state, and a manual refresh.
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  enabled = true,
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
	const fetcherRef = useRef(fetcher);
	useEffect(() => {
		fetcherRef.current = fetcher;
	}, [fetcher]);

  const tick = useCallback(async () => {
    try {
	  const d = await fetcherRef.current();
      setData(d);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "poll error");
    } finally {
      setLoading(false);
    }
	}, []);

  useEffect(() => {
    if (!enabled) return;
    const run = () => {
      if (document.hidden) return;
      void tick();
    };
    run();
    const id = setInterval(run, intervalMs);
    return () => {
      clearInterval(id);
    };
  }, [tick, intervalMs, enabled]);

  return { data, error, loading, refresh: tick };
}
