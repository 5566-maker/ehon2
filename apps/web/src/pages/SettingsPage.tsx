import { useEffect, useState } from 'react';
import {
  LANGUAGE_LABELS,
  READER_LANGUAGES,
  type ReaderLanguage,
  type TtsVoiceInfo,
} from '@ehon2/shared';
import { apiGet, apiSend, errorMessage } from '../lib/api';
import { ErrorNotice, PageLoading } from '../components/ui';

interface TtsVoicesResponse {
  voices: Record<ReaderLanguage, TtsVoiceInfo>;
}

const SOURCE_LABELS: Record<TtsVoiceInfo['source'], string> = {
  settings: '页面设置',
  env: '环境变量',
  default: '默认',
};

const GENDER_LABELS = { female: '女声', male: '男声' } as const;

export function SettingsPage() {
  const [data, setData] = useState<TtsVoicesResponse | null>(null);
  const [draft, setDraft] = useState<Record<ReaderLanguage, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const res = await apiGet<TtsVoicesResponse>('/api/settings/tts-voices');
      setData(res);
      setDraft({
        ja: res.voices.ja.effective,
        zh: res.voices.zh.effective,
        en: res.voices.en.effective,
      });
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    if (!draft || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiSend<TtsVoicesResponse>('/api/settings/tts-voices', 'PUT', draft);
      setData(res);
      setNotice('已保存。新朗读将使用新声音。');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (!data || !draft) {
    return error ? <ErrorNotice message={error} /> : <PageLoading />;
  }

  const dirty = READER_LANGUAGES.some((l) => draft[l] !== data.voices[l].effective);

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-xl font-bold">设置</h1>
      <p className="mt-1 text-sm text-cocoa-soft">选择 Kokoro 朗读在每种语言下使用的声音。</p>

      {error && (
        <div className="mt-4">
          <ErrorNotice message={error} />
        </div>
      )}
      {notice && (
        <p className="mt-4 rounded-xl bg-leaf/15 px-4 py-2 text-sm text-leaf-dark">{notice}</p>
      )}

      <div className="mt-6 space-y-4">
        {READER_LANGUAGES.map((lang) => {
          const info = data.voices[lang];
          return (
            <div key={lang} className="rounded-2xl border border-cocoa/10 bg-white/60 p-4">
              <div className="flex items-center justify-between">
                <label className="label" htmlFor={`voice-${lang}`}>
                  {LANGUAGE_LABELS[lang]}朗读声音
                </label>
                <span className="text-xs text-cocoa-soft">
                  当前：{info.effective}（{SOURCE_LABELS[info.source]}）
                </span>
              </div>
              <select
                id={`voice-${lang}`}
                className="input mt-2"
                value={draft[lang]}
                onChange={(e) => setDraft({ ...draft, [lang]: e.target.value })}
              >
                {info.options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.id}（{GENDER_LABELS[o.gender]}）
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>

      <p className="mt-4 text-xs text-cocoa-soft">
        更换声音后，已缓存的旧声音音频仍保留，新朗读使用新声音。环境变量
        KOKORO_JA_VOICE / KOKORO_ZH_VOICE / KOKORO_EN_VOICE
        可被此处的页面设置覆盖。
      </p>

      <button
        type="button"
        onClick={save}
        disabled={!dirty || saving}
        className="btn-primary mt-4 px-6 py-2 text-sm disabled:opacity-40"
      >
        {saving ? '保存中…' : '保存'}
      </button>
    </div>
  );
}
