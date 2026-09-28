import { useEffect, useRef, useState } from 'react';
import { apiSend, errorMessage } from '../lib/api';

interface ChangePasswordModalProps {
  open: boolean;
  onSuccess: () => void;
  onCancel: () => void;
}

/** Password change dialog. Never logs or echoes password values anywhere. */
export function ChangePasswordModal({ open, onSuccess, onCancel }: ChangePasswordModalProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setError(null);
      setSaving(false);
      firstRef.current?.focus();
    }
  }, [open ]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const submit = async () => {
    if (saving) return;
    if (!currentPassword) {
      setError('请输入当前密码。');
      return;
    }
    if (newPassword.length < 8) {
      setError('新密码至少 8 位。');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致。');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiSend<unknown>('/api/auth/change-password', 'POST', {
        currentPassword,
        newPassword,
        confirmPassword,
      });
      // Clear local copies immediately after use.
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      onSuccess();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fade-anim fixed inset-0 z-50 flex items-center justify-center bg-cocoa/40 p-4"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label="修改密码"
    >
      <div className="card w-full max-w-sm p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold">修改密码</h2>
        <p className="mt-1 text-xs text-cocoa-soft">
          修改后将退出所有登录，需要用新密码重新登录。
        </p>

        {error && (
          <p className="mt-3 rounded-xl bg-blush/15 px-4 py-2 text-sm text-blush-dark">{error}</p>
        )}

        <div className="mt-4 space-y-3">
          <div>
            <label className="label" htmlFor="change-pw-current">
              当前密码
            </label>
            <input
              ref={firstRef}
              id="change-pw-current"
              type="password"
              autoComplete="current-password"
              className="input mt-1"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="change-pw-new">
              新密码（至少 8 位）
            </label>
            <input
              id="change-pw-new"
              type="password"
              autoComplete="new-password"
              className="input mt-1"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="change-pw-confirm">
              确认新密码
            </label>
            <input
              id="change-pw-confirm"
              type="password"
              autoComplete="new-password"
              className="input mt-1"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
            />
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="btn-soft px-5 py-2 text-sm">
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className="btn-primary px-5 py-2 text-sm disabled:opacity-40"
          >
            {saving ? '修改中…' : '确认修改'}
          </button>
        </div>
      </div>
    </div>
  );
}
