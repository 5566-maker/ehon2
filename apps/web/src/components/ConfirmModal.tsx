import { useEffect, useRef } from 'react';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  message: string;
  confirmText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Small accessible confirm dialog (no native window.confirm). */
export function ConfirmModal({
  open,
  title,
  message,
  confirmText = '确定',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) cancelRef.current?.focus();
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
  return (
    <div
      className="fade-anim fixed inset-0 z-50 flex items-center justify-center bg-cocoa/40 p-4"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="card w-full max-w-sm p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold">{title}</h2>
        <p className="mt-2 text-sm text-cocoa-soft">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button ref={cancelRef} type="button" onClick={onCancel} className="btn-soft px-5 py-2 text-sm">
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`rounded-full px-5 py-2 text-sm font-semibold text-white transition active:scale-97 ${
              danger ? 'bg-blush hover:brightness-95' : 'btn-primary'
            }`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
