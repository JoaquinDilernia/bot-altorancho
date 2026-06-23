import { lazy, Suspense } from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { setLogoutHandler } from './lib/api';
import Layout from './components/Layout/Layout.jsx';

const Dashboard    = lazy(() => import('./pages/Dashboard.jsx'));
const Conversations = lazy(() => import('./pages/Conversations.jsx'));
const Simulator    = lazy(() => import('./pages/Simulator.jsx'));
const KnowledgeBase = lazy(() => import('./pages/KnowledgeBase.jsx'));
const Config       = lazy(() => import('./pages/Config.jsx'));
const Labels       = lazy(() => import('./pages/Labels.jsx'));
const Profile      = lazy(() => import('./pages/Profile.jsx'));
const Stats        = lazy(() => import('./pages/Stats.jsx'));
const Login        = lazy(() => import('./pages/Login.jsx'));
const QuickReplies = lazy(() => import('./pages/QuickReplies.jsx'));
const Templates    = lazy(() => import('./pages/Templates.jsx'));
const Costs        = lazy(() => import('./pages/Costs.jsx'));
const Departments     = lazy(() => import('./pages/Departments.jsx'));
const Notifications   = lazy(() => import('./pages/Notifications.jsx'));
const Users           = lazy(() => import('./pages/Users.jsx'));

function PageLoader() {
  return (
    <div style={{ padding: '32px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {[120, 80, 200, 140].map((w, i) => (
        <div key={i} style={{
          height: 14, width: w, borderRadius: 6,
          background: 'var(--color-border)',
          animation: 'pulse 1.4s ease-in-out infinite',
          animationDelay: `${i * 0.1}s`,
        }} />
      ))}
      <style>{`@keyframes pulse{0%,100%{opacity:.4}50%{opacity:1}}`}</style>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <HashRouter>
        <AppRoutes />
      </HashRouter>
    </AuthProvider>
  );
}

function AppRoutes() {
  const { agent, loading, logout } = useAuth();
  setLogoutHandler(logout);

  if (loading) return null;

  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/login" element={agent ? <Navigate to="/dashboard" replace /> : <Login />} />
        <Route path="/" element={agent ? <Layout /> : <Navigate to="/login" replace />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard"    element={<Dashboard />} />
          <Route path="conversations" element={<Conversations />} />
          <Route path="simulator"    element={<Simulator />} />
          <Route path="knowledge"    element={<KnowledgeBase />} />
          <Route path="config"       element={<Config />} />
          <Route path="labels"       element={<Labels />} />
          <Route path="profile"      element={<Profile />} />
          <Route path="stats"        element={<Stats />} />
          <Route path="quick-replies" element={<QuickReplies />} />
          <Route path="templates"    element={<Templates />} />
          <Route path="costs"        element={<Costs />} />
          <Route path="departments"   element={<Departments />} />
          <Route path="notifications" element={<Notifications />} />
          <Route path="users"         element={<Users />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
