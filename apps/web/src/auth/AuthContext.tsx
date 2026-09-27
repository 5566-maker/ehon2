import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { apiGet, apiSend, ApiError } from '../lib/api';

interface AuthState {
  loading: boolean;
  authenticated: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);

  const refresh = useCallback(async () => {
    try {
      await apiGet<{ authenticated: boolean }>('/api/auth/session');
      setAuthenticated(true);
    } catch (err) {
      if (err instanceof ApiError && err.isAuthError) setAuthenticated(false);
      else setAuthenticated(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    await apiSend<{ authenticated: boolean }>('/api/auth/login', 'POST', { username, password });
    setAuthenticated(true);
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiSend('/api/auth/logout', 'POST');
    } finally {
      setAuthenticated(false);
    }
  }, []);

  return (
    <AuthContext.Provider value={{ loading, authenticated, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
