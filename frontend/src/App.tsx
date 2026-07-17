import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Layout } from "./components/Layout";
import { useAuth } from "./hooks";
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

function ReturnToLanding() {
  useEffect(() => {
    window.location.replace("/");
  }, []);
  return (
    <div className="flex h-screen items-center justify-center">
      <Spinner />
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
          <Route path="/" element={<ReturnToLanding />} />
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
