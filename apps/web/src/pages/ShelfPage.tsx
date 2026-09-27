import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { BookListItem, BookStatus } from '@ehon2/shared';
import { apiGet, apiSend, errorMessage } from '../lib/api';
import { EmptyState, ErrorNotice, PageLoading } from '../components/ui';
import { ConfirmModal } from '../components/ConfirmModal';

const STATUS_TEXT: Record<BookStatus, string> = {
  draft: '草稿',
  uploading: '上传中',
  processing: '识别中',
  ready: '可阅读',
  failed: '失败',
};

const STATUS_CLASS: Record<BookStatus, string> = {
  draft: 'bg-cream-dark text-cocoa-soft',
  uploading: 'bg-sky/30 text-sky-dark',
  processing: 'bg-warm/60 text-cocoa',
  ready: 'bg-leaf/25 text-leaf-dark',
  failed: 'bg-blush/25 text-cocoa',
};

export function ShelfPage() {
  const navigate = useNavigate();
  const [books, setBooks] = useState<BookListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<BookListItem | null>(null);

  const load = async () => {
    setError(null);
    try {
      const data = await apiGet<{ books: BookListItem[] }>('/api/books');
      setBooks(data.books);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await apiSend(`/api/books/${deleting.id}`, 'DELETE');
      setDeleting(null);
      await load();
    } catch (err) {
      setError(errorMessage(err));
      setDeleting(null);
    }
  };

  if (error && books === null) return <ErrorNotice message={error} onRetry={load} />;
  if (books === null) return <PageLoading text="正在打开书架…" />;

  return (
    <div>
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">我的绘本 📚</h1>
          <p className="text-sm text-cocoa-soft">点一本开始亲子共读吧</p>
        </div>
        <button type="button" onClick={() => navigate('/books/new')} className="btn-primary px-5 py-2.5">
          ＋ 新绘本
        </button>
      </div>

      {error && (
        <p role="alert" className="mb-4 rounded-xl bg-blush/20 px-3 py-2 text-sm">
          {error}
        </p>
      )}

      {books.length === 0 ? (
        <EmptyState
          emoji="🌱"
          title="书架还是空的"
          hint="创建第一本绘本，上传封面和内页照片，AI 会帮你识别文字、翻译和朗读。"
        />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {books.map((book) => (
            <div key={book.id} className="card group relative overflow-hidden">
              <Link to={`/books/${book.id}`} className="block" aria-label={`打开《${book.title ?? '未命名'}》`}>
                <div className="aspect-[3/4] w-full overflow-hidden bg-cream-dark">
                  {book.coverUrl ? (
                    <img
                      src={book.coverUrl}
                      alt={book.title ?? '绘本封面'}
                      className="h-full w-full object-cover transition group-hover:scale-[1.03]"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-5xl">📕</div>
                  )}
                </div>
                <div className="p-3">
                  <p className="truncate font-semibold">{book.title ?? '未命名绘本'}</p>
                  <p className="mt-0.5 text-xs text-cocoa-soft">
                    {book.pageCount} 页 · {book.readyPageCount} 页已识别
                  </p>
                  <span
                    className={`mt-2 inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_CLASS[book.status]}`}
                  >
                    {STATUS_TEXT[book.status]}
                  </span>
                </div>
              </Link>
              <button
                type="button"
                aria-label={`删除《${book.title ?? '未命名'}》`}
                onClick={() => setDeleting(book)}
                className="absolute right-2 top-2 rounded-full bg-cream/90 px-2.5 py-1 text-xs text-cocoa-soft opacity-0 shadow transition group-hover:opacity-100 hover:text-cocoa focus:opacity-100"
              >
                删除
              </button>
            </div>
          ))}
        </div>
      )}

      <ConfirmModal
        open={deleting !== null}
        title="删除这本绘本？"
        message={`《${deleting?.title ?? '未命名'}》的所有页面、识别结果和音频都会被删除，且无法恢复。`}
        confirmText="删除"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
