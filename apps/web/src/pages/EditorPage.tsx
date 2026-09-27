import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { BBox, PageProcessingStatus, TextBlock, TextOrientation, VocabularyItem } from '@ehon2/shared';
import { apiGet, apiSend, apiUpload, errorMessage } from '../lib/api';
import { convertHeicToJpeg, isHeicFile } from '../lib/heic';
import { ErrorNotice, PageLoading, Spinner } from '../components/ui';
import { ConfirmModal } from '../components/ConfirmModal';

interface PageInfo {
  id: string;
  pageNumber: number;
  imageUrl: string;
  ocrStatus: PageProcessingStatus;
  processingError: string | null;
}

const ORIENTATIONS: { value: TextOrientation; label: string }[] = [
  { value: 'horizontal', label: '横排' },
  { value: 'vertical', label: '竖排' },
  { value: 'mixed', label: '混合' },
  { value: 'unknown', label: '未知' },
];

function toPercent(b: BBox) {
  return {
    x: Math.round(b.x * 1000) / 10,
    y: Math.round(b.y * 1000) / 10,
    width: Math.round(b.width * 1000) / 10,
    height: Math.round(b.height * 1000) / 10,
  };
}

function fromPercent(p: { x: number; y: number; width: number; height: number }): BBox {
  return { x: p.x / 100, y: p.y / 100, width: p.width / 100, height: p.height / 100 };
}

export function EditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [pageIdx, setPageIdx] = useState(0);
  const [blocks, setBlocks] = useState<TextBlock[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reprocessing, setReprocessing] = useState(false);
  const [deleting, setDeleting] = useState<TextBlock | null>(null);
  const [adding, setAdding] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [batching, setBatching] = useState(false);
  const [deletingPage, setDeletingPage] = useState<PageInfo | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Form state for the selected block
  const [form, setForm] = useState({
    originalText: '', normalizedText: '', readingText: '', chineseText: '',
    englishText: '', explanationZh: '', orientation: 'unknown' as TextOrientation,
    x: 10, y: 10, width: 30, height: 10,
  });
  const [vocab, setVocab] = useState<VocabularyItem[]>([]);

  const loadPages = useCallback(async () => {
    if (!id) return;
    const data = await apiGet<{ book: { pages: { id: string; pageNumber: number; thumbnailUrl: string; ocrStatus: PageProcessingStatus }[] } }>(
      `/api/books/${id}`,
    );
    const list: PageInfo[] = data.book.pages.map((p) => ({
      id: p.id, pageNumber: p.pageNumber, imageUrl: p.thumbnailUrl, ocrStatus: p.ocrStatus, processingError: null,
    }));
    setPages(list);
    const want = Number(searchParams.get('page') ?? '1');
    const idx = list.findIndex((p) => p.pageNumber === want);
    setPageIdx(idx >= 0 ? idx : 0);
  }, [id, searchParams]);

  const loadBlocks = useCallback(async (pageId: string) => {
    const data = await apiGet<{ blocks: TextBlock[] }>(`/api/pages/${pageId}/blocks`);
    setBlocks(data.blocks);
    setSelectedId(null);
  }, []);

  useEffect(() => {
    loadPages().catch((err) => setError(errorMessage(err)));
  }, [loadPages]);

  useEffect(() => {
    const p = pages[pageIdx];
    if (p) loadBlocks(p.id).catch((err) => setError(errorMessage(err)));
  }, [pages, pageIdx, loadBlocks]);

  const selected = blocks.find((b) => b.id === selectedId) ?? null;

  useEffect(() => {
    if (!selected) return;
    const pct = toPercent(selected.bbox);
    setForm({
      originalText: selected.originalText,
      normalizedText: selected.normalizedText ?? '',
      readingText: selected.readingText ?? '',
      chineseText: selected.chineseText ?? '',
      englishText: selected.englishText ?? '',
      explanationZh: selected.explanationZh ?? '',
      orientation: selected.orientation,
      ...pct,
    });
    setVocab(selected.vocabulary.map((v) => ({ ...v })));
  }, [selected]);

  const saveSelected = async () => {
    if (!selected) return;
    setError(null);
    setSaving(true);
    try {
      const bbox = fromPercent({ x: form.x, y: form.y, width: form.width, height: form.height });
      const data = await apiSend<{ block: TextBlock }>(`/api/text-blocks/${selected.id}`, 'PATCH', {
        originalText: form.originalText.trim(),
        normalizedText: form.normalizedText.trim() ? form.normalizedText.trim() : null,
        readingText: form.readingText.trim() ? form.readingText.trim() : null,
        chineseText: form.chineseText.trim() ? form.chineseText.trim() : null,
        englishText: form.englishText.trim() ? form.englishText.trim() : null,
        explanationZh: form.explanationZh.trim() ? form.explanationZh.trim() : null,
        orientation: form.orientation,
        bbox,
        vocabulary: vocab.filter((v) => v.word.trim()).map((v) => ({
          word: v.word.trim(),
          reading: v.reading?.trim() ? v.reading.trim() : null,
          meaning_zh: v.meaning_zh.trim(),
        })),
      });
      setBlocks((bs) => bs.map((b) => (b.id === data.block.id ? data.block : b)));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const moveSelected = async (delta: -1 | 1) => {
    if (!selected) return;
    const idx = blocks.findIndex((b) => b.id === selected.id);
    const target = idx + delta;
    if (target < 0 || target >= blocks.length) return;
    try {
      const data = await apiSend<{ block: TextBlock }>(`/api/text-blocks/${selected.id}`, 'PATCH', {
        blockOrder: target + 1,
      });
      const page = pages[pageIdx];
      if (page) await loadBlocks(page.id);
      setSelectedId(data.block.id);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const addBlock = async () => {
    const page = pages[pageIdx];
    if (!page) return;
    setAdding(true);
    try {
      const data = await apiSend<{ block: TextBlock }>(`/api/pages/${page.id}/blocks`, 'POST', {
        blockOrder: blocks.length + 1,
        originalText: '新しいテキスト',
        orientation: 'unknown',
        bbox: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
        vocabulary: [],
      });
      await loadBlocks(page.id);
      setSelectedId(data.block.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setAdding(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await apiSend(`/api/text-blocks/${deleting.id}`, 'DELETE');
      setDeleting(null);
      const page = pages[pageIdx];
      if (page) await loadBlocks(page.id);
    } catch (err) {
      setError(errorMessage(err));
      setDeleting(null);
    }
  };

  const reprocess = async () => {
    const page = pages[pageIdx];
    if (!page) return;
    setReprocessing(true);
    setError(null);
    try {
      await apiSend(`/api/pages/${page.id}/process`, 'POST', { force: true });
      await loadBlocks(page.id);
      await loadPages();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setReprocessing(false);
    }
  };

  const uploadPages = async (files: FileList | null) => {
    if (!files || files.length === 0 || !id) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      for (const f of Array.from(files)) {
        const file = isHeicFile(f) ? await convertHeicToJpeg(f) : f;
        form.append('files', file, file.name.replace(/\.(heic|heif)$/i, '.jpg'));
      }
      await apiUpload(`/api/books/${id}/pages`, form);
      await loadPages();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const movePage = async (pageId: string, delta: -1 | 1) => {
    if (!id) return;
    const ordered = [...pages].sort((a, b) => a.pageNumber - b.pageNumber);
    const idx = ordered.findIndex((p) => p.id === pageId);
    const target = idx + delta;
    if (idx < 0 || target < 0 || target >= ordered.length) return;
    const [moved] = ordered.splice(idx, 1);
    if (!moved) return;
    ordered.splice(target, 0, moved);
    setError(null);
    try {
      await apiSend(`/api/books/${id}/pages/reorder`, 'PATCH', {
        pageIds: ordered.map((p) => p.id),
      });
      await loadPages();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const confirmDeletePage = async () => {
    if (!deletingPage) return;
    setError(null);
    try {
      await apiSend(`/api/pages/${deletingPage.id}`, 'DELETE');
      setDeletingPage(null);
      await loadPages();
      setPageIdx(0);
    } catch (err) {
      setError(errorMessage(err));
      setDeletingPage(null);
    }
  };

  const processAllPending = async () => {
    const pending = pages.filter((p) => p.ocrStatus === 'pending' || p.ocrStatus === 'failed');
    if (pending.length === 0 || batching) return;
    setBatching(true);
    setError(null);
    try {
      for (const p of pending) {
        try {
          await apiSend(`/api/pages/${p.id}/process`, 'POST', {});
        } catch (err) {
          setError(`第 ${p.pageNumber} 页识别失败：${errorMessage(err)}`);
        }
        await loadPages();
      }
      const cur = pages[pageIdx];
      if (cur) await loadBlocks(cur.id);
    } finally {
      setBatching(false);
    }
  };

  if (error && pages.length === 0) return <ErrorNotice message={error} onRetry={() => loadPages()} />;
  if (pages.length === 0) return <PageLoading text="正在加载页面…" />;

  const page = pages[pageIdx] as PageInfo;
  const setF = (k: keyof typeof form, v: string | number) =>
    setForm((f) => ({ ...f, [k]: v }) as typeof form);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-3 flex items-center justify-between">
        <button type="button" onClick={() => navigate(`/books/${id}`)} className="text-sm text-cocoa-soft hover:text-cocoa">
          ← 返回目录
        </button>
        <div className="flex items-center gap-2">
          <button type="button" disabled={pageIdx === 0} onClick={() => setPageIdx((i) => i - 1)} className="btn-soft px-3 py-1.5 text-sm disabled:opacity-40">←</button>
          <select
            aria-label="选择页面"
            value={page.id}
            onChange={(e) => setPageIdx(pages.findIndex((p) => p.id === e.target.value))}
            className="input w-auto py-1.5 text-sm"
          >
            {pages.map((p) => (
              <option key={p.id} value={p.id}>
                第 {p.pageNumber} 页（{p.ocrStatus}）
              </option>
            ))}
          </select>
          <button type="button" disabled={pageIdx >= pages.length - 1} onClick={() => setPageIdx((i) => i + 1)} className="btn-soft px-3 py-1.5 text-sm disabled:opacity-40">→</button>
        </div>
        <button type="button" disabled={reprocessing} onClick={reprocess} className="btn-soft flex items-center gap-2 px-4 py-1.5 text-sm">
          {reprocessing && <Spinner size={16} />}
          {reprocessing ? 'AI 识别中…' : '✨ 重新识别本页'}
        </button>
      </div>

      {error && (
        <p role="alert" className="mb-3 rounded-xl bg-blush/20 px-3 py-2 text-sm">{error}</p>
      )}

      {/* Page management: upload, reorder, delete, batch AI */}
      <section aria-label="页面管理" className="card mb-5 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,.heic,.heif"
            multiple
            className="hidden"
            aria-label="上传页面图片"
            onChange={(e) => void uploadPages(e.target.files)}
          />
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
            className="btn-primary flex items-center gap-2 px-4 py-2 text-sm"
          >
            {uploading && <Spinner size={16} />}
            {uploading ? '上传处理中…' : '＋ 上传页面图片'}
          </button>
          <button
            type="button"
            disabled={batching || pages.every((p) => p.ocrStatus === 'ready')}
            onClick={() => void processAllPending()}
            className="btn-soft flex items-center gap-2 px-4 py-2 text-sm disabled:opacity-40"
          >
            {batching && <Spinner size={16} />}
            {batching ? '批量识别中…' : '✨ 识别全部待处理页'}
          </button>
          <p className="text-xs text-cocoa-soft">可多选，HEIC 会在手机上自动转成 JPEG 再上传，按文件名顺序追加到末尾。</p>
        </div>
        {pages.length > 0 && (
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {[...pages]
              .sort((a, b) => a.pageNumber - b.pageNumber)
              .map((p) => (
                <li key={p.id} className="flex items-center gap-3 rounded-xl bg-[#fffdf8] p-2">
                  <img src={p.imageUrl} alt={`第 ${p.pageNumber} 页缩略图`} className="h-14 w-14 rounded-lg object-cover" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">第 {p.pageNumber} 页</p>
                    <p className="text-xs text-cocoa-soft">
                      {p.ocrStatus === 'ready' ? '✅ 已识别' : p.ocrStatus === 'processing' ? '⏳ 识别中' : p.ocrStatus === 'failed' ? '❌ 识别失败' : '◌ 待识别'}
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button type="button" aria-label={`第 ${p.pageNumber} 页上移`} onClick={() => void movePage(p.id, -1)} className="btn-soft px-2 py-1 text-xs">↑</button>
                    <button type="button" aria-label={`第 ${p.pageNumber} 页下移`} onClick={() => void movePage(p.id, 1)} className="btn-soft px-2 py-1 text-xs">↓</button>
                    <button type="button" onClick={() => setDeletingPage(p)} className="btn-soft px-2 py-1 text-xs text-cocoa-soft">删除</button>
                  </div>
                </li>
              ))}
          </ul>
        )}
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Image with numbered overlays */}
        <div>
          <div className="relative select-none overflow-hidden rounded-2xl bg-cream-dark shadow">
            <img src={page.imageUrl} alt={`第 ${page.pageNumber} 页`} className="block w-full" draggable={false} />
            {blocks.map((b) => (
              <button
                key={b.id}
                type="button"
                aria-pressed={b.id === selectedId}
                aria-label={`文本块 ${b.blockOrder}`}
                onClick={() => setSelectedId(b.id === selectedId ? null : b.id)}
                className={`absolute flex items-start justify-start rounded border-2 p-0.5 text-xs font-bold ${
                  b.id === selectedId
                    ? 'border-apricot bg-apricot/25 text-cocoa'
                    : 'border-sky/70 bg-sky/15 text-cocoa'
                }`}
                style={{
                  left: `${b.bbox.x * 100}%`,
                  top: `${b.bbox.y * 100}%`,
                  width: `${b.bbox.width * 100}%`,
                  height: `${b.bbox.height * 100}%`,
                }}
              >
                <span className="rounded-full bg-cocoa/70 px-1.5 text-[10px] text-white">{b.blockOrder}</span>
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={addBlock} disabled={adding} className="btn-soft flex items-center gap-2 px-4 py-2 text-sm">
              {adding && <Spinner size={16} />}＋ 手动添加文本块
            </button>
            <p className="w-full text-xs text-cocoa-soft">点击图中的编号选择文本块，然后在右侧编辑。框的坐标用百分比表示（0–100）。</p>
          </div>
          {/* Block list */}
          <div className="mt-3 space-y-1">
            {blocks.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => setSelectedId(b.id)}
                className={`block w-full truncate rounded-xl px-3 py-2 text-left text-sm transition ${
                  b.id === selectedId ? 'bg-apricot/25 font-semibold' : 'bg-[#fffdf8] hover:bg-cream-dark'
                }`}
              >
                <span className="mr-2 inline-block w-6 text-center text-xs font-bold text-cocoa-soft">{b.blockOrder}</span>
                {b.originalText.slice(0, 40)}
              </button>
            ))}
          </div>
        </div>

        {/* Edit form */}
        <div>
          {selected ? (
            <div className="card space-y-3 p-5">
              <div className="flex items-center justify-between">
                <h2 className="font-bold">编辑文本块 #{selected.blockOrder}</h2>
                <div className="flex gap-1">
                  <button type="button" onClick={() => moveSelected(-1)} className="btn-soft px-2 py-1 text-xs" aria-label="上移顺序">↑</button>
                  <button type="button" onClick={() => moveSelected(1)} className="btn-soft px-2 py-1 text-xs" aria-label="下移顺序">↓</button>
                  <button type="button" onClick={() => setDeleting(selected)} className="btn-soft px-2 py-1 text-xs text-cocoa-soft">删除</button>
                </div>
              </div>

              <div>
                <label className="label" htmlFor="ed-original">日文原文 *</label>
                <textarea id="ed-original" className="input" rows={2} value={form.originalText} onChange={(e) => setF('originalText', e.target.value)} />
              </div>
              <div>
                <label className="label" htmlFor="ed-reading">读音（给家长看的）</label>
                <textarea id="ed-reading" className="input" rows={2} value={form.readingText} onChange={(e) => setF('readingText', e.target.value)} />
              </div>
              <div>
                <label className="label" htmlFor="ed-normalized">规范化日文（用于朗读，可空）</label>
                <textarea id="ed-normalized" className="input" rows={2} value={form.normalizedText} onChange={(e) => setF('normalizedText', e.target.value)} />
              </div>
              <div>
                <label className="label" htmlFor="ed-zh">中文翻译</label>
                <textarea id="ed-zh" className="input" rows={2} value={form.chineseText} onChange={(e) => setF('chineseText', e.target.value)} />
              </div>
              <div>
                <label className="label" htmlFor="ed-en">英文翻译</label>
                <textarea id="ed-en" className="input" rows={2} value={form.englishText} onChange={(e) => setF('englishText', e.target.value)} />
              </div>
              <div>
                <label className="label" htmlFor="ed-explain">中文讲解（讲给孩子听）</label>
                <textarea id="ed-explain" className="input" rows={2} value={form.explanationZh} onChange={(e) => setF('explanationZh', e.target.value)} />
              </div>

              <div>
                <label className="label" htmlFor="ed-orientation">文字方向</label>
                <select
                  id="ed-orientation"
                  className="input"
                  value={form.orientation}
                  onChange={(e) => setForm((f) => ({ ...f, orientation: e.target.value as TextOrientation }))}
                >
                  {ORIENTATIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>

              <fieldset>
                <legend className="label">文本框位置（百分比 0–100）</legend>
                <div className="grid grid-cols-4 gap-2">
                  {(['x', 'y', 'width', 'height'] as const).map((k) => (
                    <div key={k}>
                      <label className="label" htmlFor={`ed-bbox-${k}`}>{k === 'x' ? '左' : k === 'y' ? '上' : k === 'width' ? '宽' : '高'}</label>
                      <input
                        id={`ed-bbox-${k}`}
                        type="number"
                        min={0}
                        max={100}
                        step={0.5}
                        className="input px-2"
                        value={form[k]}
                        onChange={(e) => setF(k, Number(e.target.value))}
                      />
                    </div>
                  ))}
                </div>
              </fieldset>

              <div>
                <p className="label">生词</p>
                <div className="space-y-2">
                  {vocab.map((v, i) => (
                    <div key={i} className="flex gap-2">
                      <input aria-label="单词" className="input px-2 py-1 text-sm" placeholder="单词" value={v.word} onChange={(e) => setVocab((vs) => vs.map((x, j) => (j === i ? { ...x, word: e.target.value } : x)))} />
                      <input aria-label="读音" className="input px-2 py-1 text-sm" placeholder="读音" value={v.reading ?? ''} onChange={(e) => setVocab((vs) => vs.map((x, j) => (j === i ? { ...x, reading: e.target.value } : x)))} />
                      <input aria-label="中文意思" className="input px-2 py-1 text-sm" placeholder="中文意思" value={v.meaning_zh} onChange={(e) => setVocab((vs) => vs.map((x, j) => (j === i ? { ...x, meaning_zh: e.target.value } : x)))} />
                      <button type="button" aria-label="删除生词" onClick={() => setVocab((vs) => vs.filter((_, j) => j !== i))} className="btn-soft px-2 text-sm">✕</button>
                    </div>
                  ))}
                  <button type="button" onClick={() => setVocab((vs) => [...vs, { word: '', reading: '', meaning_zh: '' }])} className="btn-soft px-3 py-1 text-xs">
                    ＋ 添加生词
                  </button>
                </div>
              </div>

              <button type="button" onClick={saveSelected} disabled={saving} className="btn-primary flex w-full items-center justify-center gap-2 py-2.5">
                {saving && <Spinner size={18} />}
                {saving ? '保存中…' : '保存修改'}
              </button>
              <p className="text-xs text-cocoa-soft">修改文字后，已缓存的旧音频会自动失效，下次朗读会重新生成。</p>
            </div>
          ) : (
            <div className="card p-8 text-center text-cocoa-soft">
              <p className="text-4xl">✏️</p>
              <p className="mt-2 text-sm">在左侧点击一个文本块开始校对</p>
            </div>
          )}
        </div>
      </div>

      <ConfirmModal
        open={deletingPage !== null}
        title="删除这一页？"
        message={`第 ${deletingPage?.pageNumber} 页及其所有文本块和音频将被删除，其余页面会自动重新编号。`}
        confirmText="删除"
        danger
        onConfirm={confirmDeletePage}
        onCancel={() => setDeletingPage(null)}
      />

      <ConfirmModal
        open={deleting !== null}
        title="删除这个文本块？"
        message={`「${deleting?.originalText.slice(0, 30)}…」将被删除，其后的文本块会自动重新编号。`}
        confirmText="删除"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
