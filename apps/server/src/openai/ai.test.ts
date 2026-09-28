import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CoverAnalysisResultSchema,
  PageAnalysisResultSchema,
} from '@ehon2/shared';
import {
  AiService,
  resolveVoice,
  sanitizeBbox,
  selectTtsText,
  supportsCustomTemperature,
  textHash,
} from '../openai/service.js';

const validPagePayload = {
  page_summary: '小熊出门玩。',
  blocks: [
    {
      order: 1,
      original_text: 'くまさんは森へ遊びに行きました。',
      normalized_text: 'くまさんは森へ遊びに行きました。',
      reading_text: 'くまさんは もりへ あそびに いきました。',
      chinese_text: '小熊去森林里玩了。',
      english_text: 'The bear went to play in the forest.',
      explanation_zh: '这句话是说小熊去了森林玩耍。',
      vocabulary: [{ word: '森', reading: 'もり', meaning_zh: '森林' }],
      orientation: 'horizontal',
      bbox: { x: 0.18, y: 0.69, width: 0.55, height: 0.08 },
      confidence: 0.93,
    },
  ],
};

describe('AI structured-output parsing', () => {
  it('accepts a valid page analysis payload', () => {
    const r = PageAnalysisResultSchema.safeParse(validPagePayload);
    assert.equal(r.success, true);
  });

  it('rejects a page payload missing required properties', () => {
    const bad = { page_summary: 'x', blocks: [{ order: 1 }] };
    assert.equal(PageAnalysisResultSchema.safeParse(bad).success, false);
  });

  it('rejects invalid orientation', () => {
    const bad = structuredClone(validPagePayload);
    const blk = bad.blocks[0];
    assert.ok(blk);
    blk.orientation = 'diagonal';
    assert.equal(PageAnalysisResultSchema.safeParse(bad).success, false);
  });

  it('rejects out-of-range confidence', () => {
    const bad = structuredClone(validPagePayload);
    const blk = bad.blocks[0];
    assert.ok(blk);
    blk.confidence = 1.5;
    assert.equal(PageAnalysisResultSchema.safeParse(bad).success, false);
  });

  it('accepts a valid cover payload with nulls', () => {
    const r = CoverAnalysisResultSchema.safeParse({
      title: 'ぐりとぐら',
      subtitle: null,
      title_reading: null,
      author: '中川李枝子',
      illustrator: null,
      publisher: null,
      isbn: null,
      language: 'ja',
      confidence: 0.9,
    });
    assert.equal(r.success, true);
  });

  it('rejects a cover payload missing confidence', () => {
    const { confidence: _drop, ...rest } = {
      title: 'x', subtitle: null, title_reading: null, author: null,
      illustrator: null, publisher: null, isbn: null, language: 'ja', confidence: 0.9,
    };
    void _drop;
    assert.equal(CoverAnalysisResultSchema.safeParse(rest).success, false);
  });
});

describe('sanitizeBbox', () => {
  it('passes through a valid bbox', () => {
    assert.deepEqual(sanitizeBbox({ x: 0.1, y: 0.2, width: 0.3, height: 0.1 }), {
      x: 0.1, y: 0.2, width: 0.3, height: 0.1,
    });
  });

  it('clamps slight overflow', () => {
    const b = sanitizeBbox({ x: 0.9, y: 0.9, width: 0.3, height: 0.3 });
    assert.ok(b);
    assert.ok(b.x + b.width <= 1 && b.y + b.height <= 1);
  });

  it('rejects zero-area and non-finite boxes', () => {
    assert.equal(sanitizeBbox({ x: 0.1, y: 0.1, width: 0, height: 0.1 }), null);
    assert.equal(sanitizeBbox({ x: NaN, y: 0, width: 0.1, height: 0.1 }), null);
  });
});

describe('TTS helpers', () => {
  it('textHash is stable and changes with text', () => {
    assert.equal(textHash('hello'), textHash('hello'));
    assert.notEqual(textHash('hello'), textHash('hello!'));
    assert.match(textHash('hello'), /^[0-9a-f]{64}$/);
  });

  it('selectTtsText follows ja->normalized/original, zh->chinese, en->english', () => {
    const block = {
      readingText: null,
      normalizedText: 'norm',
      originalText: 'orig',
      chineseText: '中文',
      englishText: null,
    };
    assert.equal(selectTtsText(block, 'ja'), 'norm');
    assert.equal(selectTtsText({ ...block, normalizedText: null }, 'ja'), 'orig');
    assert.equal(selectTtsText(block, 'zh'), '中文');
    assert.equal(selectTtsText(block, 'en'), null);
  });

  it('selectTtsText prefers the kana reading for Japanese (avoids Chinese misreading)', () => {
    const block = {
      readingText: 'おおがた じんいん ゆそうしゃ',
      normalizedText: '大型人员输送车',
      originalText: '大型人员输送车',
      chineseText: '大型人员运输车',
      englishText: null,
    };
    // Kanji (esp. simplified-form glyphs) would be read as Chinese.
    assert.equal(selectTtsText(block, 'ja'), 'おおがた じんいん ゆそうしゃ');
    assert.equal(selectTtsText({ ...block, readingText: '   ' }, 'ja'), '大型人员输送车');
    assert.equal(selectTtsText({ ...block, readingText: null }, 'ja'), '大型人员输送车');
  });

  it('resolveVoice maps "default" to configured voices', () => {
    const env = {
      DEFAULT_JA_VOICE: 'alloy',
      DEFAULT_ZH_VOICE: 'echo',
      DEFAULT_EN_VOICE: 'verse',
    } as never;
    assert.equal(resolveVoice(env, 'ja', 'default'), 'alloy');
    assert.equal(resolveVoice(env, 'zh', 'default'), 'echo');
    assert.equal(resolveVoice(env, 'en', 'nova'), 'nova');
  });
});

/* ------------------------------------------------------------------ */
/* temperature handling per model (fake OpenAI client — no network)     */
/* ------------------------------------------------------------------ */

function captureClient(content: unknown) {
  const captured: { args?: Record<string, unknown> } = {};
  const client = {
    chat: {
      completions: {
        create: async (args: Record<string, unknown>) => {
          captured.args = args;
          return { choices: [{ message: { content: JSON.stringify(content) } }] };
        },
      },
    },
  } as never;
  return { client, captured };
}

const validCoverPayload = {
  title: 'ぐりとぐら',
  subtitle: null,
  title_reading: null,
  author: '中川李枝子',
  illustrator: null,
  publisher: null,
  isbn: null,
  language: 'ja',
  confidence: 0.9,
};

async function coverRequestModel(model: string): Promise<Record<string, unknown>> {
  const { client, captured } = captureClient(validCoverPayload);
  const svc = new AiService(
    { OPENAI_API_KEY: 'k', OPENAI_VISION_MODEL: model } as never,
    { client },
  );
  await svc.analyzeCover({ imageBytes: Buffer.from([1, 2, 3]), mimeType: 'image/jpeg' });
  assert.ok(captured.args, 'expected the request args to be captured');
  return captured.args;
}

describe('supportsCustomTemperature', () => {
  it('rejects the gpt-5.6 family (luna/sol 400 on explicit temperature)', () => {
    assert.equal(supportsCustomTemperature('gpt-5.6-luna'), false);
    assert.equal(supportsCustomTemperature('gpt-5.6-sol'), false);
    assert.equal(supportsCustomTemperature('gpt-5'), false);
    assert.equal(supportsCustomTemperature('gpt-5-mini'), false);
  });

  it('keeps temperature for gpt-4o and other classic models', () => {
    assert.equal(supportsCustomTemperature('gpt-4o'), true);
    assert.equal(supportsCustomTemperature('gpt-4o-mini'), true);
    assert.equal(supportsCustomTemperature('gpt-4.1'), true);
  });
});

describe('chatJson temperature payload', () => {
  it('omits temperature for gpt-5.6-luna', async () => {
    const args = await coverRequestModel('gpt-5.6-luna');
    assert.equal(args.model, 'gpt-5.6-luna');
    assert.equal('temperature' in args, false);
  });

  it('omits temperature for gpt-5.6-sol', async () => {
    const args = await coverRequestModel('gpt-5.6-sol');
    assert.equal('temperature' in args, false);
  });

  it('sends temperature 0 for gpt-4o', async () => {
    const args = await coverRequestModel('gpt-4o');
    assert.equal(args.temperature, 0);
  });
});
