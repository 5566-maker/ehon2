import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { BookDetail, PageProcessingStatus, PageSummary } from '@ehon2/shared';
import { apiGet, apiSend, apiUpload, errorMessage, ApiError } from '../lib/api';
import { prepareUploadFile } from '../lib/heic';
import { EmptyState, ErrorNotice, PageLoading, Spinner } from '../components/ui';
import { ConfirmModal } from '../components/ConfirmModal';

const STATUS_TEXT: Record<PageProcessingStatus, string> = {
  pending: '待识别',
  processing: '识别中',
  ready: '已识别',
  failed: '失败',
};

const STATUS_CLASS: Record<PageProcessingStatus, string> = {
  pending: 'bg-cream-dark text-cocoa-soft',
  processing: 'bg-warm/60 text-cocoa',
  ready: 'bg-leaf/25 text-leaf-dark',
  failed: 'bg-blush/25 text-cocoa',
};

export function BookDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const pagesInputRef = useRef<HTMLInputElement>(null);
  const [book, setBook] = useState<BookDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const [deletingPage, setDeletingPage] = useState<PageSummary | null>(null);
  const [deletingBook, setDeletingBook] = useState(false);
  const [editingMeta, setEditingMeta] = useState(false);
  const [metaDraft, setMetaDraft] = useState({ title: '', author: '', publisher: '' });
  const batchCancelRef = useRef(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const data = await apiGet<{ book: BookDetail }>(`/api/books/${id}`);
      setBook(data.book);
      setMetaDraft({
        title: data.book.title ?? '',
        author: data.book.author ?? '',
        publisher: data.book.publisher ?? '',
      });
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) navigate('/', { replace: true });
      else setError(errorMessage(err));
    }
  }, [id, navigate]);

  useEffect(() => {
    void load();
  }, [load]);

  const patchPageStatus = (pageId: string, status: PageProcessingStatus, processingError: string | null = null) => {
    setBook((b) =>
      b
        ? {
            ...b,
            pages: b.pages.map((p) => (p.id === pageId ? { ...p, ocrStatus: status } : p)),
          }
        : b,
    );
    void processingError;
  };

  const processPage = async (pageId: string): Promise<boolean> => {
    setProcessingIds((s) => new Set(s).add(pageId));
    patchPageStatus(pageId, 'processing');
    try {
      const data = await apiSend<{ status: PageProcessingStatus; blocks: unknown[] }>(
        `/api/pages/${pageId}/process`,
        'POST',
        {},
      );
      patchPageStatus(pageId, data.status);
      return data.status === 'ready';
    } catch (err) {
      patchPageStatus(pageId, 'failed');
      setError(errorMessage(err));
      return false;
    } finally {
      setProcessingIds((s) => {
        const next = new Set(s);
        next.delete(pageId);
        return next;
      });
      void load();
    }
  };

  const processAll = async () => {
    if (!book || batchRunning) return;
    const queue = book.pages.filter((p) => p.ocrStatus === 'pending' || p.ocrStatus === 'failed');
    if (queue.length === 0) return;
    batchCancelRef.current = false;
    setBatchRunning(true);
    setBatchProgress({ done: 0, total: queue.length });
    let done = 0;
    for (const p of queue) {
      if (batchCancelRef.current) break;
      await processPage(p.id);
      done += 1;
      setBatchProgress({ done, total: queue.length });
    }
    setBatchRunning(false);
    setBatchProgress(null);
    await load();
  };

  const onUploadPages = async (files: FileList | null) => {
    if (!files || files.length === 0 || !id) return;
    setError(null);
    setUploading(true);
    try {
      const form = new FormData();
      for (const f of Array.from(files)) {
        form.append('files', await prepareUploadFile(f));
      }
      await apiUpload(`/api/books/${id}/pages`, form);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  const movePage = async (page: PageSummary, delta: -1 | 1) => {
    if (!book) return;
    const idx = book.pages.findIndex((p) => p.id === page.id);
    const target = idx + delta;
    if (target < 0 || target >= book.pages.length) return;
    const ids = book.pages.map((p) => p.id);
    [ids[idx], ids[target]] = [ids[idx] as string, ids[target] as string];
    try {
      await apiSend(`/api/books/${book.id}/pages/reorder`, 'PATCH', { pageIds: ids });
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const confirmDeletePage = async () => {
    if (!deletingPage) return;
    try {
      await apiSend(`/api/pages/${deletingPage.id}`, 'DELETE');
      setDeletingPage(null);
      await load();
    } catch (err) {
      setError(errorMessage(err));
      setDeletingPage(null);
    }
  };

  const confirmDeleteBook = async () => {
    if (!id) return;
    try {
      await apiSend(`/api/books/${id}`, 'DELETE');
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setDeletingBook(false);
    }
  };

  const saveMeta = async () => {
    if (!id) return;
    try {
      await apiSend(`/api/books/${id}`, 'PATCH', {
        title: metaDraft.title.trim() ? metaDraft.title.trim() : null,
        author: metaDraft.author.trim() ? metaDraft.author.trim() : null,
        publisher: metaDraft.publisher.trim() ? metaDraft.publisher.trim() : null,
      });
      setEditingMeta(false);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (error && !book) return <ErrorNotice message={error} onRetry={load} />;
  if (!book) return <PageLoading text="正在打开绘本…" />;

  const pendingCount = book.pages.filter((p) => p.ocrStatus === 'pending' || p.ocrStatus === 'failed').length;

  return (
    <div>
      <button type="button" onClick={() => navigate('/')} className="mb-4 text-sm text-cocoa-soft hover:text-cocoa">
        ← 返回书架
      </button>

      {error && (
        <p role="alert" className="mb-4 rounded-xl bg-blush/20 px-3 py-2 text-sm">
          {error}
        </p>
      )}

      {/* Header: cover + metadata + actions */}
      <div className="card mb-6 flex flex-col gap-5 p-5 sm:flex-row">
        <div className="mx-auto h-56 w-40 shrink-0 overflow-hidden rounded-xl bg-cream-dark sm:mx-0">
          {book.coverUrl ? (
            <img src={book.coverUrl} alt="封面" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-5xl">📕</div>
          )}
        </div>
        <div className="flex-1">
          {editingMeta ? (
            <div className="space-y-2">
              <div>
                <label className="label" htmlFor="edit-title">书名</label>
                <input id="edit-title" className="input" value={metaDraft.title} onChange={(e) => setMetaDraft({ ...metaDraft, title: e.target.value })} />
              </div>
              <div>
                <label className="label" htmlFor="edit-author">作者</label>
                <input id="edit-author" className="input" value={metaDraft.author} onChange={(e) => setMetaDraft({ ...metaDraft, author: e.target.value })} />
              </div>
              <div>
                <label className="label" htmlFor="edit-publisher">出版社</label>
                <input id="edit-publisher" className="input" value={metaDraft.publisher} onChange={(e) => setMetaDraft({ ...metaDraft, publisher: e.target.value })} />
              </div>
              <div className="flex gap-2 pt-1">
                <button type="button" onClick={saveMeta} className="btn-primary px-4 py-1.5 text-sm">保存</button>
                <button type="button" onClick={() => setEditingMeta(false)} className="btn-soft px-4 py-1.5 text-sm">取消</button>
              </div>
            </div>
          ) : (
            <>
              <h1 className="text-2xl font-bold">{book.title ?? '未命名绘本'}</h1>
              <p className="mt-1 text-sm text-cocoa-soft">
                {[book.author, book.illustrator, book.publisher].filter(Boolean).join(' · ') || '暂无作者信息'}
              </p>
              <p className="mt-2 text-sm text-cocoa-soft">
                {book.counts.total} 页 · {book.counts.ready} 页已识别
                {book.counts.failed > 0 && ` · ${book.counts.failed} 页失败`}
              </p>
              <button type="button" onClick={() => setEditingMeta(true)} className="mt-2 text-sm text-sky-dark hover:underline">
                编辑信息
              </button>
            </>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Link to={`/books/${book.id}/read`} className="btn-primary px-5 py-2 text-sm">
              📖 开始阅读
            </Link>
            <Link to={`/books/${book.id}/editor`} className="btn-soft px-5 py-2 text-sm">
              ✏️ 校对文字
            </Link>
            <button type="button" onClick={() => setDeletingBook(true)} className="btn-soft px-4 py-2 text-sm text-cocoa-soft">
              删除绘本
            </button>
          </div>
        </div>
      </div>

      {/* Pages */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold">内页（{book.pages.length}）</h2>
        <div className="flex flex-wrap gap-2">
          <input
            ref={pagesInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            aria-label="上传内页照片"
            onChange={(e) => {
              void onUploadPages(e.target.files);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            disabled={uploading}
            onClick={() => pagesInputRef.current?.click()}
            className="btn-soft flex items-center gap-2 px-4 py-2 text-sm"
          >
            {uploading && <Spinner size={16} />}
            {uploading ? '上传中…' : '＋ 上传内页'}
          </button>
          {pendingCount > 0 && (
            batchRunning ? (
              <button type="button" onClick={() => { batchCancelRef.current = true; }} className="btn-soft px-4 py-2 text-sm">
                停止（{batchProgress ? `${batchProgress.done}/${batchProgress.total}` : ''}）
              </button>
            ) : (
              <button type="button" onClick={processAll} className="btn-primary px-4 py-2 text-sm">
                ✨ 识别全部（{pendingCount} 页）
              </button>
            )
          )}
        </div>
      </div>

      {book.pages.length === 0 ? (
        <EmptyState emoji="📷" title="还没有内页" hint="用手机拍摄绘本内页并上传，AI 会逐页识别文字。建议按顺序拍摄。" />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {book.pages.map((page, idx) => {
            const busy = processingIds.has(page.id);
            return (
              <div key={page.id} className="card overflow-hidden">
                <div className="relative aspect-[3/4] bg-cream-dark">
                  <img src={page.thumbnailUrl} alt={`第 ${page.pageNumber} 页`} className="h-full w-full object-cover" loading="lazy" />
                  <span className="absolute left-2 top-2 rounded-full bg-cocoa/70 px-2 py-0.5 text-xs font-semibold text-white">
                    P{page.pageNumber}
                  </span>
                  <span className={`absolute right-2 top-2 rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_CLASS[page.ocrStatus]}`}>
                    {busy ? '识别中' : STATUS_TEXT[page.ocrStatus]}
                  </span>
                  {busy && (
                    <div className="absolute inset-0 flex items-center justify-center bg-cream/60">
                      <Spinner size={28} className="text-leaf-dark" />
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-between p-2">
                  <div className="flex gap-1">
                    <button type="button" aria-label="上移" disabled={idx === 0 || busy} onClick={() => movePage(page, -1)} className="btn-soft px-2 py-1 text-xs disabled:opacity-40">↑</button>
                    <button type="button" aria-label="下移" disabled={idx === book.pages.length - 1 || busy} onClick={() => movePage(page, 1)} className="btn-soft px-2 py-1 text-xs disabled:opacity-40">↓</button>
                  </div>
                  <div className="flex gap-1">
                    {(page.ocrStatus === 'pending' || page.ocrStatus === 'failed') && (
                      <button type="button" disabled={busy} onClick={() => processPage(page.id)} className="btn-soft px-2 py-1 text-xs disabled:opacity-40">
                        ✨ 识别
                      </button>
                    )}
                    {page.ocrStatus === 'ready' && (
                      <Link to={`/books/${book.id}/editor?page=${page.pageNumber}`} className="btn-soft px-2 py-1 text-xs">
                        校对
                      </Link>
                    )}
                    <button type="button" aria-label={`删除第 ${page.pageNumber} 页`} disabled={busy} onClick={() => setDeletingPage(page)} className="btn-soft px-2 py-1 text-xs text-cocoa-soft disabled:opacity-40">
                      删除
                    </button>
                  </div>
                </div>
                <p className="px-2 pb-2 text-center text-xs text-cocoa-soft">{page.blockCount} 个文本块</p>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmModal
        open={deletingPage !== null}
        title="删除这一页？"
        message={`第 ${deletingPage?.pageNumber} 页的图片和识别结果都会被删除。`}
        confirmText="删除"
        danger
        onConfirm={confirmDeletePage}
        onCancel={() => setDeletingPage(null)}
      />
      <ConfirmModal
        open={deletingBook}
        title="删除整本绘本？"
        message="所有页面、识别结果和音频都会被删除，且无法恢复。"
        confirmText="删除"
        danger
        onConfirm={confirmDeleteBook}
        onCancel={() => setDeletingBook(false)}
      />
    </div>
  );
}
