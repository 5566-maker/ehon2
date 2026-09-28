import { Navigate, createBrowserRouter, RouterProvider } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { Layout } from './components/Layout';
import { PageLoading } from './components/ui';
import { LoginPage } from './pages/LoginPage';
import { ShelfPage } from './pages/ShelfPage';
import { BookNewPage } from './pages/BookNewPage';
import { BookDetailPage } from './pages/BookDetailPage';
import { ReaderPage } from './pages/ReaderPage';
import { EditorPage } from './pages/EditorPage';
import { SettingsPage } from './pages/SettingsPage';

function RequireAuth({ children }: { children: ReactNode }) {
  const { loading, authenticated } = useAuth();
  if (loading) return <PageLoading text="正在确认登录状态…" />;
  if (!authenticated) return <Navigate to="/login" replace />;
  return <Layout>{children}</Layout>;
}

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <ShelfPage />
      </RequireAuth>
    ),
  },
  {
    path: '/books/new',
    element: (
      <RequireAuth>
        <BookNewPage />
      </RequireAuth>
    ),
  },
  {
    path: '/books/:id',
    element: (
      <RequireAuth>
        <BookDetailPage />
      </RequireAuth>
    ),
  },
  {
    path: '/books/:id/read',
    element: (
      <RequireAuth>
        <ReaderPage />
      </RequireAuth>
    ),
  },
  {
    path: '/books/:id/editor',
    element: (
      <RequireAuth>
        <EditorPage />
      </RequireAuth>
    ),
  },
  {
    path: '/settings',
    element: (
      <RequireAuth>
        <SettingsPage />
      </RequireAuth>
    ),
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);

export function App() {
  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  );
}
