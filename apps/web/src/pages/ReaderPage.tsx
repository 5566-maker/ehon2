import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTtsPlayer } from '../hooks/useTtsPlayer.js';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { LANGUAGE_LABELS, type BBox, type ReaderBlock, type ReaderData, type ReaderLanguage } from '@ehon2/shared';
import { apiGet, apiSend, errorMessage } from '../lib/api';
import { ErrorNotice, PageLoading, Spinner } from '../components/ui';

const LANGS: ReaderLanguage[] = ['ja', 'zh', 'en'];

function bboxStyle(b: BBox): React.CSSProperties {
  return {
    left: `${b.x * 100}%`,
    top: `${b.y * 100}%`,
    width: `${b.width * 100}%`,
    height: `${b.height * 100}%`,
  };
}

/** Hit target: centered on the bbox, at least 44px each side. */
function hitStyle(b: BBox): React.CSSProperties {
  return {
    left: `${(b.x + b.width / 2) * 100}%`,
    top: `${(b.y + b.height / 2) * 100}%`,
    width: `max(${(b.width * 100).toFixed(2)}%, 44px)`,
    height: `max(${(b.height * 100).toFixed(2)}%, 44px)`,
    transform: 'translate(-50%, -50%)',
  };
}

export function ReaderPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<ReaderData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageIdx, setPageIdx] = useState(0);
  const [selected, setSelected] = useState<ReaderBlock | null>(null);
  const [lang, setLang] = useState<ReaderLanguage>('ja');
  const [mode, setMode] = useState<'text' | 'read'>('text');
  const [ttsLoading, setTtsLoading] = useState<{ blockId: string; lang: ReaderLanguage } | null>(null);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<{ blockId: string; lang: ReaderLanguage } | null>(null);
  const player = useTtsPlayer({
    onEnded: () => setPlaying(null),
    onError: () => {
      setTtsError('音频播放失败，请重试。');
      setPlaying(null);
    },
  });
  const touchX = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const res = await apiGet<ReaderData>(`/api/books/${id}/reader`);
      setData(res);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const page = data?.pages[pageIdx] ?? null;
  const totalPages = data?.pages.length ?? 0;

  const goPage = useCallback(
    (delta: number) => {
      setPageIdx((i) => {
        const next = Math.min(Math.max(i + delta, 0), totalPages - 1);
        return next;
      });
      setSelected(null);
      stopAudio();
    },
    [totalPages],
  );

  const stopAudio = () => {
    player.stop();
    setPlaying(null);
  };

  // Keyboard navigation (desktop).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') goPage(1);
      if (e.key === 'ArrowLeft') goPage(-1);
      if (e.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goPage]);

  const playTts = async (block: ReaderBlock, language: ReaderLanguage) => {
    const key = `${block.id}:${language}`;
    if (playing && playing.blockId === block.id && playing.lang === language && player.isActive()) {
      // Toggle pause for the currently playing block+language.
      const paused = await player.toggle();
      if (paused !== null) setPlaying(paused ? null : { blockId: block.id, lang: language });
      return;
    }
    stopAudio();
    setTtsError(null);
    setTtsLoading({ blockId: block.id, lang: language });
    try {
      const res = await apiSend<{ audioUrl: string }>(`/api/text-blocks/${block.id}/audio`, 'POST', {
        language,
      });
      // The player fully decodes the clip before starting (plus a short
      // leading silence pad), so the first syllable is never clipped.
      const started = await player.play(key, res.audioUrl);
      if (started) setPlaying({ blockId: block.id, lang: language });
    } catch (err) {
      setTtsError(errorMessage(err));
    } finally {
      setTtsLoading(null);
    }
  };

  const primaryText = useMemo(() => {
    if (!selected) return '';
    if (lang === 'zh') return selected.chineseText ?? '';
    if (lang === 'en') return selected.englishText ?? '';
    return selected.normalizedText ?? selected.originalText;
  }, [selected, lang]);

  if (error && !data) return <ErrorNotice message={error} onRetry={load} />;
  if (!data) return <PageLoading text="正在打开绘本…" />;
  if (data.pages.length === 0) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <p className="text-5xl">🌱</p>
        <p className="mt-3 font-semibold">这本绘本还没有内页</p>
        <Link to={`/books/${id}`} className="btn-primary mt-4 inline-block px-5 py-2 text-sm">
          去上传内页
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      {/* Top bar */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <button type="button" onClick={() => navigate(`/books/${id}`)} className="text-sm text-cocoa-soft hover:text-cocoa">
          ← 目录
        </button>
        <p className="truncate text-sm font-semibold">{data.book.title ?? '未命名绘本'}</p>
        <div className="flex rounded-full bg-cream-dark p-1" role="group" aria-label="语言">
          {LANGS.map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLang(l)}
              aria-pressed={lang === l}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                lang === l ? 'bg-leaf text-white shadow' : 'text-cocoa-soft hover:text-cocoa'
              }`}
            >
              {LANGUAGE_LABELS[l]}
            </button>
          ))}
        </div>
      </div>

      {/* Mode toggle: text (dialog) vs read-aloud (tap to play) */}
      <div className="mb-3 flex justify-center">
        <div className="flex rounded-full bg-cream-dark p-1" role="group" aria-label="阅读模式">
          {(
            [
              { value: 'text', label: '文本' },
              { value: 'read', label: '朗读' },
            ] as const
          ).map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => {
                setMode(m.value);
                setSelected(null);
                stopAudio();
              }}
              aria-pressed={mode === m.value}
              className={`rounded-full px-5 py-1 text-xs font-semibold transition ${
                mode === m.value ? 'bg-leaf text-white shadow' : 'text-cocoa-soft hover:text-cocoa'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Page image with hotspots */}
      <div
        className="relative select-none overflow-hidden rounded-2xl bg-cream-dark shadow"
        onTouchStart={(e) => {
          touchX.current = e.touches[0]?.clientX ?? null;
        }}
        onTouchEnd={(e) => {
          const start = touchX.current;
          const end = e.changedTouches[0]?.clientX;
          touchX.current = null;
          if (start === null || end === undefined) return;
          const dx = end - start;
          if (Math.abs(dx) > 60) goPage(dx < 0 ? 1 : -1);
        }}
      >
        {page && (
          <img
            key={page.id}
            src={page.imageUrl}
            alt={`第 ${page.pageNumber} 页`}
            className="fade-anim block w-full"
            draggable={false}
          />
        )}
        {page?.ocrStatus !== 'ready' && (
          <div className="absolute inset-0 flex items-center justify-center bg-cream/70">
            <p className="text-sm text-cocoa-soft">
              {page?.ocrStatus === 'processing' || page?.ocrStatus === 'pending'
                ? '这一页还在识别中…'
                : '这一页识别失败，请先在书页管理中重试'}
            </p>
          </div>
        )}
        {page?.blocks.map((b) => {
          const isSelected = selected?.id === b.id;
          const isPlaying = playing?.blockId === b.id;
          // One block can own multiple precise OCR regions; all share the
          // same selected state and open the same panel. Legacy blocks fall
          // back to the single bbox.
          const clickTargets = b.regions.length > 0 ? b.regions : [b.bbox];
          return (
            <div key={b.id}>
              {clickTargets.map((r, i) => (
                <div key={i}>
                  {/* visual highlight (exact region, never moves) */}
                  <div
                    aria-hidden="true"
                    className={`pointer-events-none absolute rounded ${isSelected || isPlaying ? 'hotspot-selected border-2' : 'border-2 border-transparent'}`}
                    style={bboxStyle(r)}
                  />
                  {/* expanded hit target */}
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    aria-label={`文本 ${b.order}：${b.originalText.slice(0, 30)}`}
                    className="absolute cursor-pointer bg-transparent"
                    style={hitStyle(r)}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (mode === 'read') {
                        // Read-aloud mode: tap once to play this block in the
                        // current language, no dialog.
                        void playTts(b, lang);
                      } else {
                        stopAudio();
                        setSelected(isSelected ? null : b);
                      }
                    }}
                  />
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {/* Page navigation */}
      <div className="mt-4 flex items-center justify-between">
        <button type="button" onClick={() => goPage(-1)} disabled={pageIdx === 0} className="btn-soft px-5 py-2 text-sm disabled:opacity-40">
          ← 上一页
        </button>
        <p className="text-sm font-semibold tabular-nums" aria-live="polite">
          {pageIdx + 1} / {totalPages}
        </p>
        <button
          type="button"
          onClick={() => goPage(1)}
          disabled={pageIdx >= totalPages - 1}
          className="btn-soft px-5 py-2 text-sm disabled:opacity-40"
        >
          下一页 →
        </button>
      </div>
      <p className="mt-2 text-center text-xs text-cocoa-soft">
        {mode === 'read' ? '点一下文字直接朗读 · 左右滑动也可以翻页' : '点一下图中的文字试试 · 左右滑动也可以翻页'}
      </p>
      {mode === 'read' && ttsError && (
        <p role="alert" className="mx-auto mt-2 max-w-md rounded-xl bg-blush/20 px-3 py-2 text-center text-sm">{ttsError}</p>
      )}

      {/* Bottom sheet */}
      {selected && (
        <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="文本详情">
          <div className="absolute inset-0 bg-cocoa/30" onClick={() => { setSelected(null); stopAudio(); }} />
          <div className="sheet-anim absolute inset-x-0 bottom-0 mx-auto max-h-[75vh] w-full max-w-2xl overflow-y-auto rounded-t-3xl bg-[#fffdf8] p-5 pb-8 shadow-2xl">
            <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-cream-dark" aria-hidden="true" />
            <div className="mb-3 flex items-start justify-between gap-2">
              <p className="text-xs font-semibold text-cocoa-soft">文本 {selected.order}</p>
              <button
                type="button"
                aria-label="关闭"
                onClick={() => { setSelected(null); stopAudio(); }}
                className="btn-soft px-3 py-1 text-sm"
              >
                ✕
              </button>
            </div>

            <p className="text-lg font-semibold leading-relaxed">{primaryText || selected.originalText}</p>
            {lang === 'ja' && selected.readingText && (
              <p className="mt-1 text-sm text-sky-dark">{selected.readingText}</p>
            )}

            <div className="mt-4 space-y-3 text-sm">
              <div className="rounded-xl bg-cream p-3">
                <p className="label">📝 日文原文</p>
                <p className="leading-relaxed">{selected.originalText}</p>
                {selected.readingText && <p className="mt-1 text-sky-dark">{selected.readingText}</p>}
              </div>
              {selected.chineseText && (
                <div className="rounded-xl bg-cream p-3">
                  <p className="label">🇨🇳 中文翻译</p>
                  <p className="leading-relaxed">{selected.chineseText}</p>
                </div>
              )}
              {selected.englishText && (
                <div className="rounded-xl bg-cream p-3">
                  <p className="label">🇬🇧 English</p>
                  <p className="leading-relaxed">{selected.englishText}</p>
                </div>
              )}
              {selected.explanationZh && (
                <div className="rounded-xl bg-warm/40 p-3">
                  <p className="label">💡 给孩子讲</p>
                  <p className="leading-relaxed">{selected.explanationZh}</p>
                </div>
              )}
              {selected.vocabulary.length > 0 && (
                <div className="rounded-xl bg-cream p-3">
                  <p className="label">📖 生词</p>
                  <ul className="space-y-1">
                    {selected.vocabulary.map((v, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="font-semibold">{v.word}</span>
                        {v.reading && <span className="text-sky-dark">{v.reading}</span>}
                        <span className="text-cocoa-soft">{v.meaning_zh}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* TTS controls */}
            <div className="mt-4">
              <p className="label">🔊 朗读</p>
              {ttsError && (
                <p role="alert" className="mb-2 rounded-xl bg-blush/20 px-3 py-2 text-sm">{ttsError}</p>
              )}
              <div className="flex flex-wrap gap-2">
                {LANGS.map((l) => {
                  const isThisLoading = ttsLoading?.blockId === selected.id && ttsLoading?.lang === l;
                  const isThisPlaying = playing?.blockId === selected.id && playing?.lang === l;
                  return (
                    <button
                      key={l}
                      type="button"
                      onClick={() => playTts(selected, l)}
                      disabled={ttsLoading !== null}
                      aria-pressed={isThisPlaying}
                      className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition active:scale-97 disabled:opacity-60 ${
                        isThisPlaying ? 'bg-apricot text-white shadow' : 'btn-soft'
                      }`}
                    >
                      {isThisLoading ? <Spinner size={16} /> : <span aria-hidden="true">{isThisPlaying ? '⏸' : '▶'}</span>}
                      {LANGUAGE_LABELS[l]}
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-xs text-cocoa-soft">音频生成后会自动缓存，下次直接播放。</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
