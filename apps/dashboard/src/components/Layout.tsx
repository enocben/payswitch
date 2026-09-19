import { NavLink, useNavigate } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "../auth/AuthContext";

const linkCls = ({ isActive }: { isActive: boolean }) =>
  `rounded px-3 py-1.5 text-sm font-medium ${isActive ? "bg-gray-900 text-white" : "text-gray-700 hover:bg-gray-100"}`;

export default function Layout({ children }: { children: ReactNode }) {
  const { loggedIn, email, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3">
          <span className="text-lg font-bold">Payswitch</span>
          {loggedIn && (
            <nav className="flex gap-1">
              <NavLink to="/payments" className={linkCls}>Transactions</NavLink>
              <NavLink to="/routing" className={linkCls}>Routing</NavLink>
              <NavLink to="/collections" className={linkCls}>Collections</NavLink>
            </nav>
          )}
          <div className="ml-auto flex items-center gap-3 text-sm">
            {loggedIn ? (
              <>
                <span className="text-gray-500">{email}</span>
                <button
                  className="rounded border px-3 py-1.5 hover:bg-gray-100"
                  onClick={() => void logout().then(() => navigate("/login"))}
                >
                  Logout
                </button>
              </>
            ) : (
              <NavLink to="/login" className={linkCls}>Login</NavLink>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
