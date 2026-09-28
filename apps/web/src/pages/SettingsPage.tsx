import { useEffect, useState } from 'react';
import {
  LANGUAGE_LABELS,
  READER_LANGUAGES,
  type ReaderLanguage,
  type TtsSpeedInfo,
  type TtsVoiceInfo,
} from '@ehon2/shared';
import { apiGet, apiSend, errorMessage } from '../lib/api';
import { ErrorNotice, PageLoading } from '../components/ui';
import { ChangePasswordModal } from '../components/ChangePasswordModal';

interface TtsSettingsResponse {
  voices: Record<ReaderLanguage, TtsVoiceInfo>;
  speeds: Record<ReaderLanguage, TtsSpeedInfo>;
}

const SOURCE_LABELS: Record<TtsVoiceInfo['source'], string> = {
  settings: '页面设置',
  env: '环境变量',
  default: '默认',
};

const GENDER_LABELS = { female: '女声', male: '男声' } as const;

export function SettingsPage() {
  const [data, setData] = useState<TtsSettingsResponse | null>(null);
  const [draftVoices, setDraftVoices] = useState<Record<ReaderLanguage, string> | null>(null);
  const [draftSpeeds, setDraftSpeeds] = useState<Record<ReaderLanguage, number> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);

  const onPasswordChanged = () => {
    setPwOpen(false);
    setNotice('修改成功，请重新登录');
    // Sessions were revoked server-side; force a full reload to the login page.
    window.setTimeout(() => {
      window.location.href = '/login';
    }, 1500);
  };

  const load = async () => {
    try {
      const res = await apiGet<TtsSettingsResponse>('/api/settings/tts');
      setData(res);
      setDraftVoices({
        ja: res.voices.ja.effective,
        zh: res.voices.zh.effective,
        en: res.voices.en.effective,
      });
      setDraftSpeeds({
        ja: res.speeds.ja.effective,
        zh: res.speeds.zh.effective,
        en: res.speeds.en.effective,
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
    if (!draftVoices || !draftSpeeds || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiSend<TtsSettingsResponse>('/api/settings/tts', 'PUT', {
        voices: draftVoices,
        speeds: draftSpeeds,
      });
      setData(res);
      setNotice('已保存。新朗读将使用新的声音和语速。');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (!data || !draftVoices || !draftSpeeds) {
    return error ? <ErrorNotice message={error} /> : <PageLoading />;
  }

  const dirty =
    READER_LANGUAGES.some((l) => draftVoices[l] !== data.voices[l].effective) ||
    READER_LANGUAGES.some((l) => draftSpeeds[l] !== data.speeds[l].effective);

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-xl font-bold">设置</h1>
      <p className="mt-1 text-sm text-cocoa-soft">选择 Kokoro 朗读在每种语言下使用的声音和语速。</p>

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
          const voice = data.voices[lang];
          const speed = data.speeds[lang];
          return (
            <div key={lang} className="rounded-2xl border border-cocoa/10 bg-white/60 p-4">
              <p className="text-sm font-semibold">{LANGUAGE_LABELS[lang]}朗读</p>

              <div className="mt-3 flex items-center justify-between">
                <label className="label" htmlFor={`voice-${lang}`}>
                  声音
                </label>
                <span className="text-xs text-cocoa-soft">
                  当前：{voice.effective}（{SOURCE_LABELS[voice.source]}）
                </span>
              </div>
              <select
                id={`voice-${lang}`}
                className="input mt-1"
                value={draftVoices[lang]}
                onChange={(e) => setDraftVoices({ ...draftVoices, [lang]: e.target.value })}
              >
                {voice.options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.id}（{GENDER_LABELS[o.gender]}）
                  </option>
                ))}
              </select>

              <div className="mt-3 flex items-center justify-between">
                <label className="label" htmlFor={`speed-${lang}`}>
                  语速
                </label>
                <span className="text-xs text-cocoa-soft">
                  当前：{speed.effective.toFixed(1)}x（{SOURCE_LABELS[speed.source]}）
                </span>
              </div>
              <select
                id={`speed-${lang}`}
                className="input mt-1"
                value={String(draftSpeeds[lang])}
                onChange={(e) =>
                  setDraftSpeeds({ ...draftSpeeds, [lang]: Number(e.target.value) })
                }
              >
                {speed.options.map((o) => (
                  <option key={o} value={String(o)}>
                    {o.toFixed(1)}x
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>

      <p className="mt-4 text-xs text-cocoa-soft">
        更换声音或语速后，已缓存的旧音频仍保留，新朗读使用新设置。环境变量
        KOKORO_JA_VOICE / KOKORO_ZH_VOICE / KOKORO_EN_VOICE 与 TTS_SPEED_JA /
        TTS_SPEED_ZH / TTS_SPEED_EN / TTS_SPEED 可被此处的页面设置覆盖。
      </p>

      <div className="mt-4 rounded-2xl border border-cocoa/10 bg-white/60 p-4">
        <p className="text-sm font-semibold">账号安全</p>
        <p className="mt-1 text-xs text-cocoa-soft">
          修改登录密码。修改后将退出所有登录，需要用新密码重新登录。
        </p>
        <button
          type="button"
          onClick={() => setPwOpen(true)}
          className="btn-soft mt-3 px-5 py-2 text-sm"
        >
          修改密码
        </button>
      </div>

      <ChangePasswordModal open={pwOpen} onSuccess={onPasswordChanged} onCancel={() => setPwOpen(false)} />

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
