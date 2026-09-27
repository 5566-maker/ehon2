import { useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CoverMetadata } from '@ehon2/shared';
import { apiGet, apiSend, apiUpload, errorMessage } from '../lib/api';
import { prepareUploadFile } from '../lib/heic';
import { PageLoading, ErrorNotice } from '../components/ui';
import { Spinner } from '../components/ui';

interface DraftBook {
  id: string;
  coverUrl: string | null;
}

type MetaTextKey = 'title' | 'subtitle' | 'titleReading' | 'author' | 'illustrator' | 'publisher' | 'isbn';

const META_FIELDS: { key: MetaTextKey; label: string }[] = [
  { key: 'title', label: '书名' },
  { key: 'subtitle', label: '副标题' },
  { key: 'titleReading', label: '书名读音' },
  { key: 'author', label: '作者' },
  { key: 'illustrator', label: '绘者' },
  { key: 'publisher', label: '出版社' },
  { key: 'isbn', label: 'ISBN' },
];

export function BookNewPage() {
  const navigate = useNavigate();
  const coverInputRef = useRef<HTMLInputElement>(null);
  const [book, setBook] = useState<DraftBook | null>(null);
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [meta, setMeta] = useState<CoverMetadata>({
    title: null, subtitle: null, titleReading: null, author: null,
    illustrator: null, publisher: null, isbn: null, language: 'ja', confidence: 0,
  });
  const [analyzed, setAnalyzed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ensureBook = async (): Promise<DraftBook> => {
    if (book) return book;
    setCreating(true);
    try {
      const data = await apiSend<{ book: { id: string } }>('/api/books', 'POST', {
        title: null,
        language: 'ja',
      });
      const created = { id: data.book.id, coverUrl: null };
      setBook(created);
      return created;
    } finally {
      setCreating(false);
    }
  };

  const onCoverChange = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      const b = await ensureBook();
      const uploadable = await prepareUploadFile(file);
      const form = new FormData();
      form.append('file', uploadable);
      const data = await apiUpload<{ coverUrl: string }>(`/api/books/${b.id}/cover`, form);
      setBook({ ...b, coverUrl: data.coverUrl });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  const onAnalyze = async () => {
    if (!book) return;
    setError(null);
    setAnalyzing(true);
    try {
      const data = await apiSend<{ metadata: CoverMetadata }>(
        `/api/books/${book.id}/cover/analyze`,
        'POST',
      );
      setMeta({ ...data.metadata });
      setAnalyzed(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setAnalyzing(false);
    }
  };

  const onSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!book) return;
    setError(null);
    setSaving(true);
    try {
      const payload: Record<string, string | null> = { language: meta.language || 'ja' };
      for (const f of META_FIELDS) payload[f.key] = meta[f.key]?.trim() ? (meta[f.key] as string).trim() : null;
      await apiSend(`/api/books/${book.id}`, 'PATCH', payload);
      navigate(`/books/${book.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const setField = (key: MetaTextKey | 'language', value: string) =>
    setMeta((m) => ({ ...m, [key]: value === '' ? null : value }));

  if (creating && !book) return <PageLoading text="正在创建绘本…" />;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-1 text-2xl font-bold">创建新绘本 🌱</h1>
      <p className="mb-5 text-sm text-cocoa-soft">先上传封面，AI 会帮你识别书名和作者，再手动确认保存。</p>

      {error && (
        <p role="alert" className="mb-4 rounded-xl bg-blush/20 px-3 py-2 text-sm">
          {error}
        </p>
      )}

      <div className="card mb-5 p-5">
        <p className="label">封面照片</p>
        <div className="flex flex-col items-center gap-4 sm:flex-row">
          <div className="flex h-48 w-36 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-cream-dark">
            {book?.coverUrl ? (
              <img src={book.coverUrl} alt="封面预览" className="h-full w-full object-cover" />
            ) : (
              <span className="text-5xl">🖼️</span>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <input
              ref={coverInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              aria-label="选择封面照片"
              onChange={(e) => {
                void onCoverChange(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              disabled={uploading}
              onClick={() => coverInputRef.current?.click()}
              className="btn-soft flex items-center justify-center gap-2 px-5 py-2 text-sm"
            >
              {uploading && <Spinner size={16} />}
              {uploading ? '上传中…' : book?.coverUrl ? '重新上传封面' : '上传封面'}
            </button>
            <button
              type="button"
              disabled={!book?.coverUrl || analyzing}
              onClick={onAnalyze}
              className="btn-primary flex items-center justify-center gap-2 px-5 py-2 text-sm"
            >
              {analyzing && <Spinner size={16} />}
              {analyzing ? 'AI 识别中…' : '✨ AI 提取书名信息'}
            </button>
            {analyzed && (
              <p className="text-xs text-cocoa-soft">
                识别完成（置信度 {Math.round(meta.confidence * 100)}%），请检查并修正后再保存。
              </p>
            )}
          </div>
        </div>
      </div>

      <form onSubmit={onSave} className="card space-y-4 p-5">
        {META_FIELDS.map((f) => (
          <div key={f.key}>
            <label className="label" htmlFor={`meta-${f.key}`}>
              {f.label}
            </label>
            <input
              id={`meta-${f.key}`}
              className="input"
              value={(meta[f.key] as string | null) ?? ''}
              onChange={(e) => setField(f.key, e.target.value)}
            />
          </div>
        ))}
        <div>
          <label className="label" htmlFor="meta-language">
            语言
          </label>
          <input
            id="meta-language"
            className="input"
            value={meta.language}
            onChange={(e) => setField('language', e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={() => navigate('/')} className="btn-soft px-5 py-2 text-sm">
            取消
          </button>
          <button type="submit" disabled={!book || saving} className="btn-primary flex items-center gap-2 px-6 py-2 text-sm">
            {saving && <Spinner size={16} />}
            保存并继续
          </button>
        </div>
      </form>
    </div>
  );
}
