export function Spinner({ size = 24, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={`animate-spin ${className}`}
      aria-label="加载中"
      role="status"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.2" />
      <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function PageLoading({ text = '加载中…' }: { text?: string }) {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-cocoa-soft">
      <Spinner size={36} className="text-leaf" />
      <p className="text-sm">{text}</p>
    </div>
  );
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="card mx-auto max-w-md p-6 text-center">
      <p className="text-4xl">🍂</p>
      <p className="mt-2 font-semibold">出错了</p>
      <p className="mt-1 text-sm text-cocoa-soft">{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="btn-soft mt-4 px-5 py-2 text-sm">
          重试
        </button>
      )}
    </div>
  );
}

export function EmptyState({ emoji, title, hint }: { emoji: string; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      <p className="float-anim text-6xl">{emoji}</p>
      <p className="mt-2 text-lg font-semibold">{title}</p>
      {hint && <p className="max-w-xs text-sm text-cocoa-soft">{hint}</p>}
    </div>
  );
}
