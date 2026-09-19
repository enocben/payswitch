import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { login as apiLogin, logout as apiLogout, ApiError } from "../lib/api";

interface AuthState {
  loggedIn: boolean;
  email: string | null;
  error: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loggedIn, setLoggedIn] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const login = useCallback(async (mail: string, password: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiLogin(mail, password);
      setLoggedIn(res.ok !== false);
      setEmail(res.user?.email ?? mail);
      return true;
    } catch (e) {
      const err = e as ApiError;
      // 401/429 surface server messages (incl. rate-limit lockout); 0 = API down.
      setError(err.status === 0 ? "API unreachable — check VITE_API_URL and that the API is running." : err.message);
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } catch {
      /* session may already be gone; still clear local state */
    }
    setLoggedIn(false);
    setEmail(null);
  }, []);

  return (
    <AuthContext.Provider value={{ loggedIn, email, error, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
