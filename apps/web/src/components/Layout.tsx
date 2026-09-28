import { Link, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';

export function Layout({ children }: { children: ReactNode }) {
  const { logout } = useAuth();
  const navigate = useNavigate();

  const onLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-30 border-b border-cocoa/10 bg-cream/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Link to="/" className="flex items-center gap-2" aria-label="回到书架">
            <span className="text-2xl" aria-hidden="true">
              📚
            </span>
            <span className="text-lg font-bold tracking-wide">Yomikiki Books</span>
          </Link>
          <div className="flex items-center gap-2">
            <Link
              to="/settings"
              aria-label="设置"
              className="btn-soft px-3 py-1.5 text-sm"
            >
              ⚙️
            </Link>
            <button type="button" onClick={onLogout} className="btn-soft px-4 py-1.5 text-sm">
              退出登录
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">{children}</main>
      <footer className="pb-6 text-center text-xs text-cocoa-soft">
        私人家庭绘本阅读助手 · 仅供家人使用 🌿
      </footer>
    </div>
  );
}
