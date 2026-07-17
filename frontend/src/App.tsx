import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Layout } from "./components/Layout";
import { useAuth } from "./hooks";
import { api } from "./api";
import Servers from "./pages/Servers";
import ServerDetail from "./pages/ServerDetail";
import Projects from "./pages/Projects";
import ProjectDetail from "./pages/ProjectDetail";
import Deployments from "./pages/Deployments";
import DeploymentDetail from "./pages/DeploymentDetail";
import Settings from "./pages/Settings";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!user) {
    return <UnauthorizedRedirect />;
  }
  return <>{children}</>;
}

function UnauthorizedRedirect() {
  useEffect(() => {
    window.location.replace("/?auth=unauthorized");
  }, []);

  return (
    <div className="flex h-screen items-center justify-center">
      <Spinner />
    </div>
  );
}

function LandingRoute() {
  const { user, loading } = useAuth();
  const [devLoginError, setDevLoginError] = useState(false);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (user) return <Navigate to="/projects" replace />;

  const devLogin = async () => {
    try {
      await api.devLogin();
      window.location.assign("/projects");
    } catch {
      setDevLoginError(true);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-void-bg px-6 py-12">
      <div className="w-full max-w-md rounded-2xl border border-void-border bg-void-panel/80 p-8 text-center shadow-2xl">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-void-accent/20 text-2xl text-void-accent">∅</div>
        <h1 className="mt-5 text-3xl font-semibold tracking-tight text-white">void</h1>
        <p className="mt-3 text-sm leading-6 text-void-dim">Self-hosted edge-driven PaaS. Sign in to manage your projects.</p>
        <div className="mt-7 space-y-3">
          <a className="btn-primary block w-full text-center" href="/api/auth/github?returnTo=%2Fprojects">Continue with GitHub</a>
          <button className="btn-secondary w-full" type="button" onClick={() => void devLogin()}>Local test login</button>
        </div>
        {devLoginError ? <p className="mt-4 text-xs text-void-err">Local test login is available only in the test stand.</p> : null}
      </div>
    </div>
  );
}

function AnimatedRoutes() {
  const location = useLocation();
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={location.pathname}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.22, ease: "easeOut" }}
        className="h-full"
      >
        <Routes location={location}>
          <Route
            path="/dashboard"
            element={<Navigate to="/projects" replace />}
          />
          <Route
            path="/servers"
            element={
              <RequireAuth>
                <Servers />
              </RequireAuth>
            }
          />
          <Route
            path="/servers/:id"
            element={
              <RequireAuth>
                <ServerDetail />
              </RequireAuth>
            }
          />
          <Route
            path="/projects"
            element={
              <RequireAuth>
                <Projects />
              </RequireAuth>
            }
          />
          <Route
            path="/projects/:id"
            element={
              <RequireAuth>
                <ProjectDetail />
              </RequireAuth>
            }
          />
          <Route
            path="/projects/:id/:section"
            element={
              <RequireAuth>
                <ProjectDetail />
              </RequireAuth>
            }
          />
          <Route
            path="/deployments"
            element={
              <RequireAuth>
                <Deployments />
              </RequireAuth>
            }
          />
          <Route
            path="/deployments/:id"
            element={
              <RequireAuth>
                <DeploymentDetail />
              </RequireAuth>
            }
          />
          <Route
            path="/settings"
            element={
              <RequireAuth>
                <Settings />
              </RequireAuth>
            }
          />
          <Route path="/" element={<LandingRoute />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </motion.div>
    </AnimatePresence>
  );
}

export default function App() {
  return (
    <Layout>
      <AnimatedRoutes />
    </Layout>
  );
}

// local import to avoid circular noise
import { Spinner } from "./components/ui";
