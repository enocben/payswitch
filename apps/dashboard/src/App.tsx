import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import Layout from "./components/Layout";
import LoginPage from "./pages/LoginPage";
import TransactionsPage from "./pages/TransactionsPage";
import TransactionDetailPage from "./pages/TransactionDetailPage";
import RoutingPage from "./pages/RoutingPage";
import CollectionsPage from "./pages/CollectionsPage";

function RequireAuth({ children }: { children: ReactNode }) {
  const { loggedIn } = useAuth();
  const location = useLocation();
  if (!loggedIn) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

export default function App() {
  return (
    <AuthProvider>
      <Layout>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/payments" element={<RequireAuth><TransactionsPage /></RequireAuth>} />
          <Route path="/payments/:id" element={<RequireAuth><TransactionDetailPage /></RequireAuth>} />
          <Route path="/routing" element={<RequireAuth><RoutingPage /></RequireAuth>} />
          <Route path="/collections" element={<RequireAuth><CollectionsPage /></RequireAuth>} />
          <Route path="/" element={<Navigate to="/payments" replace />} />
          <Route path="*" element={<Navigate to="/payments" replace />} />
        </Routes>
      </Layout>
    </AuthProvider>
  );
}
