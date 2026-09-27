import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { errorMessage } from '../lib/api';
import { Spinner } from '../components/ui';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(username.trim(), password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <p className="float-anim text-7xl" aria-hidden="true">
            📖
          </p>
          <h1 className="mt-3 text-2xl font-bold">Yomikiki Books</h1>
          <p className="mt-1 text-sm text-cocoa-soft">和孩子一起读日文绘本 🌙</p>
        </div>
        <form onSubmit={onSubmit} className="card space-y-4 p-6">
          <div>
            <label className="label" htmlFor="username">
              用户名
            </label>
            <input
              id="username"
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="password">
              密码
            </label>
            <input
              id="password"
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          {error && (
            <p role="alert" className="rounded-xl bg-blush/20 px-3 py-2 text-sm font-medium text-cocoa">
              {error}
            </p>
          )}
          <button type="submit" disabled={busy} className="btn-primary flex w-full items-center justify-center gap-2 py-2.5">
            {busy && <Spinner size={18} />}
            {busy ? '登录中…' : '进入书架'}
          </button>
        </form>
        <p className="mt-4 text-center text-xs text-cocoa-soft">私人应用 · 登录状态保存在这台设备上</p>
      </div>
    </div>
  );
}
