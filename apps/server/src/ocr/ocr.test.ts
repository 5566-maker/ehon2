import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCodes } from '@ehon2/shared';
import {
  createOcrProvider,
  extractFragments,
  GoogleVisionOcrProvider,
  OcrError,
  regionsForOcrIds,
  resolveOcrProviderName,
  sanitizeNormalizedBbox,
  unionBbox,
  verticesToBbox,
} from './index.js';
import { AiService, AiError } from '../openai/service.js';
import type { OcrFragment } from './types.js';

/* ------------------------------------------------------------------ */
/* Geometry normalization                                              */
/* ------------------------------------------------------------------ */

/** Approximate bbox equality (implementation does float subtraction). */
function bboxClose(actual: { x: number; y: number; width: number; height: number } | null, expected: { x: number; y: number; width: number; height: number }) {
  assert.ok(actual, 'expected a bbox, got null');
  for (const k of ['x', 'y', 'width', 'height'] as const) {
    assert.ok(Math.abs(actual[k] - expected[k]) < 1e-9, `${k}: ${actual[k]} !~= ${expected[k]}`);
  }
}

describe('verticesToBbox', () => {
  it('converts absolute pixel vertices to normalized bbox', () => {
    bboxClose(
      verticesToBbox(
        [
          { x: 100, y: 200 },
          { x: 300, y: 200 },
          { x: 300, y: 250 },
          { x: 100, y: 250 },
        ],
        1000,
        1000,
      ),
      { x: 0.1, y: 0.2, width: 0.2, height: 0.05 },
    );
  });

  it('clamps out-of-range vertices to 0..1', () => {
    const bbox = verticesToBbox(
      [
        { x: -50, y: -20 },
        { x: 1100, y: 1200 },
      ],
      1000,
      1000,
    );
    assert.deepEqual(bbox, { x: 0, y: 0, width: 1, height: 1 });
  });

  it('returns null for degenerate and missing geometry', () => {
    assert.equal(verticesToBbox([{ x: 5, y: 5 }], 100, 100), null);
    assert.equal(verticesToBbox([], 100, 100), null);
    assert.equal(verticesToBbox(undefined, 100, 100), null);
    assert.equal(verticesToBbox([{ x: 5, y: 5 }, { x: 5, y: 5 }], 100, 100), null);
    assert.equal(verticesToBbox([{ x: 1, y: 1 }], 0, 100), null);
  });
});

describe('sanitizeNormalizedBbox', () => {
  it('leaves in-range boxes untouched', () => {
    bboxClose(sanitizeNormalizedBbox({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }), { x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
  });

  it('clamps origin and shrinks overflow', () => {
    const b = sanitizeNormalizedBbox({ x: -0.1, y: 0.9, width: 0.5, height: 0.5 });
    assert.equal(b.x, 0);
    assert.ok(b.width <= 1 && b.height <= 1 - 0.9);
  });
});

describe('unionBbox', () => {
  it('returns the union of multiple boxes', () => {
    bboxClose(
      unionBbox([
        { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        { x: 0.4, y: 0.5, width: 0.2, height: 0.1 },
      ]),
      { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
    );
  });

  it('returns null for an empty list', () => {
    assert.equal(unionBbox([]), null);
  });
});

/* ------------------------------------------------------------------ */
/* Fragment extraction from Vision responses                            */
/* ------------------------------------------------------------------ */

function visionPage(paragraphs: { text: string; vertices: { x: number; y: number }[] }[]) {
  return {
    responses: [
      {
        fullTextAnnotation: {
          pages: [
            {
              blocks: [
                {
                  paragraphs: paragraphs.map((p) => ({
                    boundingBox: { vertices: p.vertices },
                    words: p.text.split(' ').map((w) => ({ symbols: [{ text: w }] })),
                  })),
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

describe('extractFragments', () => {
  const annotationOf = (paras: { text: string; vertices: { x: number; y: number }[] }[]) =>
    visionPage(paras).responses[0]!.fullTextAnnotation;

  it('emits one fragment per paragraph with normalized geometry', () => {
    const { fragments: frags } = extractFragments(
      annotationOf([
        { text: 'Hello world', vertices: [{ x: 100, y: 200 }, { x: 500, y: 200 }, { x: 500, y: 260 }, { x: 100, y: 260 }] },
      ]),
      1000,
      1000,
    );
    assert.equal(frags.length, 1);
    assert.equal(frags[0]?.text, 'Hello world');
    bboxClose(frags[0]?.bbox ?? null, { x: 0.1, y: 0.2, width: 0.4, height: 0.06 });
    assert.equal(frags[0]?.pageIndex, 0);
    assert.equal(frags[0]?.blockIndex, 0);
    assert.equal(frags[0]?.paragraphIndex, 0);
    // Regression: page index must not leak into wordIndex.
    assert.equal(frags[0]?.wordIndex, undefined);
  });

  it('joins CJK words without spaces', () => {
    const { fragments: frags } = extractFragments(
      annotationOf([
        { text: 'くま さん', vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }] },
      ]),
      1000,
      1000,
    );
    assert.equal(frags[0]?.text, 'くまさん');
  });

  it('skips empty paragraphs and invalid geometry', () => {
    const { fragments: frags } = extractFragments(
      annotationOf([
        { text: '   ', vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }] },
        { text: 'ok', vertices: [] },
      ]),
      1000,
      1000,
    );
    assert.equal(frags.length, 0);
  });

  it('handles missing annotation', () => {
    assert.deepEqual(extractFragments(undefined, 100, 100).fragments, []);
  });
});

/* ------------------------------------------------------------------ */
/* regionsForOcrIds                                                    */
/* ------------------------------------------------------------------ */

describe('regionsForOcrIds', () => {
  const frags: OcrFragment[] = [
    { id: 'ocr_001', text: 'a', bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 }, pageIndex: 0, blockIndex: 0, paragraphIndex: 0 },
    { id: 'ocr_002', text: 'b', bbox: { x: 0.4, y: 0.5, width: 0.2, height: 0.1 }, pageIndex: 0, blockIndex: 0, paragraphIndex: 1 },
  ];
  const byId = new Map(frags.map((f) => [f.id, f]));

  it('maps ocr_ids to regions preserving order', () => {
    const regions = regionsForOcrIds(['ocr_002', 'ocr_001'], byId);
    assert.deepEqual(regions.map((r) => r.ocrId), ['ocr_002', 'ocr_001']);
    bboxClose(regions[0] ?? null, { x: 0.4, y: 0.5, width: 0.2, height: 0.1 });
    bboxClose(regions[1] ?? null, { x: 0.1, y: 0.1, width: 0.2, height: 0.1 });
  });

  it('throws INVALID_OCR_REFERENCE for unknown ids', () => {
    assert.throws(
      () => regionsForOcrIds(['ocr_999'], byId),
      (err: unknown) => err instanceof OcrError && err.code === ErrorCodes.INVALID_OCR_REFERENCE,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Google Vision provider (fetchImpl mocked — no network, no billing)   */
/* ------------------------------------------------------------------ */

function okFetch(payload: unknown) {
  return (async () =>
    new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
}

describe('GoogleVisionOcrProvider', () => {
  it('requires an API key', () => {
    assert.throws(
      () => new GoogleVisionOcrProvider({ apiKey: '' }),
      (err: unknown) => err instanceof OcrError && /GOOGLE_VISION_API_KEY/.test(err.message),
    );
  });

  it('assigns stable ocr_### ids and normalizes bboxes', async () => {
    const provider = new GoogleVisionOcrProvider({
      apiKey: 'sentinel-key',
      fetchImpl: okFetch(
        visionPage([
          { text: 'one', vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }] },
          { text: 'two', vertices: [{ x: 0, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 150 }, { x: 0, y: 150 }] },
        ]),
      ),
    });
    const result = await provider.recognize({ imageBytes: Buffer.from('img'), mimeType: 'image/png', width: 1000, height: 1000 });
    assert.equal(result.provider, 'google-vision');
    assert.deepEqual(result.fragments.map((f) => f.id), ['ocr_001', 'ocr_002']);
    bboxClose(result.fragments[1]?.bbox ?? null, { x: 0, y: 0.1, width: 0.1, height: 0.05 });
  });

  it('surfaces Vision-level errors without leaking the key', async () => {
    const provider = new GoogleVisionOcrProvider({
      apiKey: 'sentinel-key-xyz',
      fetchImpl: okFetch({ responses: [{ error: { code: 3, message: 'Image has no content.' } }] }),
    });
    await assert.rejects(
      () => provider.recognize({ imageBytes: Buffer.from('img'), mimeType: 'image/png', width: 10, height: 10 }),
      (err: unknown) => {
        assert.ok(err instanceof OcrError && err.code === ErrorCodes.OCR_PROVIDER_FAILED);
        assert.match(err.message, /Image has no content/);
        assert.ok(!err.message.includes('sentinel-key-xyz'), 'key must not leak into errors');
        return true;
      },
    );
  });

  it('maps HTTP and network failures to OCR_PROVIDER_FAILED', async () => {
    const httpFail = new GoogleVisionOcrProvider({
      apiKey: 'k',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { message: 'backend error' } }), { status: 500 })) as typeof fetch,
    });
    await assert.rejects(() => httpFail.recognize({ imageBytes: Buffer.from('x'), mimeType: 'image/png', width: 1, height: 1 }), (err: unknown) => err instanceof OcrError && err.code === ErrorCodes.OCR_PROVIDER_FAILED);

    const netFail = new GoogleVisionOcrProvider({
      apiKey: 'k',
      fetchImpl: (async () => { throw new Error('socket hangup'); }) as typeof fetch,
    });
    await assert.rejects(() => netFail.recognize({ imageBytes: Buffer.from('x'), mimeType: 'image/png', width: 1, height: 1 }), (err: unknown) => err instanceof OcrError && err.code === ErrorCodes.OCR_PROVIDER_FAILED);
  });

  it('reports OCR_EMPTY_RESULT when Vision finds no text', async () => {
    const provider = new GoogleVisionOcrProvider({ apiKey: 'k', fetchImpl: okFetch({ responses: [{}] }) });
    await assert.rejects(
      () => provider.recognize({ imageBytes: Buffer.from('x'), mimeType: 'image/png', width: 1, height: 1 }),
      (err: unknown) => err instanceof OcrError && err.code === ErrorCodes.OCR_EMPTY_RESULT,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Provider resolution                                                 */
/* ------------------------------------------------------------------ */

describe('provider resolution', () => {
  it('defaults to google', () => {
    assert.equal(resolveOcrProviderName({} as never), 'google');
  });

  it('honors OCR_PROVIDER=openai-legacy', () => {
    assert.equal(resolveOcrProviderName({ OCR_PROVIDER: 'openai-legacy' } as never), 'openai-legacy');
  });

  it('falls back to legacy when Google is disabled', () => {
    assert.equal(resolveOcrProviderName({ GOOGLE_VISION_ENABLED: false } as never), 'openai-legacy');
  });

  it('defaults unknown provider names to google', () => {
    assert.equal(resolveOcrProviderName({ OCR_PROVIDER: 'bogus' } as never), 'google');
  });

  it('createOcrProvider builds a google provider with a key', () => {
    const p = createOcrProvider({ GOOGLE_VISION_API_KEY: 'k' } as never);
    assert.equal(p.name, 'google-vision');
  });

  it('createOcrProvider explains a missing key', () => {
    assert.throws(
      () => createOcrProvider({} as never),
      (err: unknown) => err instanceof OcrError && /GOOGLE_VISION_API_KEY/.test(err.message),
    );
  });

  it('createOcrProvider refuses to build the legacy path (handled by AiService)', () => {
    assert.throws(
      () => createOcrProvider({ OCR_PROVIDER: 'openai-legacy' } as never),
      (err: unknown) => err instanceof OcrError && err.code === ErrorCodes.INTERNAL_ERROR && /legacy OpenAI OCR path/.test(err.message),
    );
  });
});

/* ------------------------------------------------------------------ */
/* OpenAI enrichment (fake OpenAI client — no network)                  */
/* ------------------------------------------------------------------ */

function fakeAiClient(content: unknown, capture?: { user?: string }) {
  return {
    chat: {
      completions: {
        create: async (args: { messages: { content: unknown }[] }) => {
          const userMsg = args.messages.find((m) => (m as { role?: string }).role === 'user');
          if (capture && userMsg) capture.user = JSON.stringify((userMsg as { content: unknown }).content);
          return { choices: [{ message: { content: JSON.stringify(content) } }] };
        },
      },
    },
  } as never;
}

const fragList: OcrFragment[] = [
  { id: 'ocr_001', text: 'くまさん', bbox: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 }, pageIndex: 0, blockIndex: 0, paragraphIndex: 0 },
  { id: 'ocr_002', text: '森へ', bbox: { x: 0.5, y: 0.1, width: 0.2, height: 0.1 }, pageIndex: 0, blockIndex: 0, paragraphIndex: 1 },
];

function enrichService(payload: unknown, capture?: { user?: string }) {
  return new AiService({ OPENAI_API_KEY: 'k', OPENAI_VISION_MODEL: 'gpt-4o' } as never, {
    client: fakeAiClient(payload, capture),
  });
}

const validEnrichment = {
  page_summary: '小熊去了森林。',
  reading_blocks: [
    {
      order: 1,
      ocr_ids: ['ocr_001', 'ocr_002'],
      original_text: 'くまさん森へ',
      normalized_text: 'くまさん森へ',
      reading_text: 'くまさん もりへ',
      chinese_text: '小熊去了森林。',
      english_text: 'The bear went to the forest.',
      explanation_zh: '小熊去了森林。',
      vocabulary: [{ word: '森', reading: 'もり', meaning_zh: '森林' }],
      orientation: 'horizontal',
      confidence: 0.9,
    },
  ],
};

describe('AiService.enrichPage', () => {
  it('returns blocks with ocrIds and no geometry', async () => {
    const capture: { user?: string } = {};
    const svc = enrichService(validEnrichment, capture);
    const out = await svc.enrichPage({ imageBytes: Buffer.from('img'), mimeType: 'image/png', fragments: fragList });
    assert.equal(out.blocks.length, 1);
    assert.deepEqual(out.blocks[0]?.ocrIds, ['ocr_001', 'ocr_002']);
    assert.ok(!('bbox' in (out.blocks[0] as object)), 'enrichment must not carry geometry');
    // The model saw the fragment ids in the prompt.
    assert.ok(capture.user?.includes('ocr_001') && capture.user?.includes('ocr_002'));
  });

  it('rejects unknown ocr ids', async () => {
    const bad = structuredClone(validEnrichment);
    bad.reading_blocks[0]!.ocr_ids = ['ocr_001', 'ocr_999'];
    const svc = enrichService(bad);
    await assert.rejects(
      () => svc.enrichPage({ imageBytes: Buffer.from('img'), mimeType: 'image/png', fragments: fragList }),
      (err: unknown) => err instanceof AiError && err.code === ErrorCodes.INVALID_OCR_REFERENCE,
    );
  });

  it('dedupes repeated ocr ids within a block', async () => {
    const dup = structuredClone(validEnrichment);
    dup.reading_blocks[0]!.ocr_ids = ['ocr_001', 'ocr_001', 'ocr_002'];
    const svc = enrichService(dup);
    const out = await svc.enrichPage({ imageBytes: Buffer.from('img'), mimeType: 'image/png', fragments: fragList });
    assert.deepEqual(out.blocks[0]?.ocrIds, ['ocr_001', 'ocr_002']);
  });

  it('rejects blocks with empty ocr_ids', async () => {
    const empty = structuredClone(validEnrichment);
    empty.reading_blocks[0]!.ocr_ids = [];
    const svc = enrichService(empty);
    await assert.rejects(
      () => svc.enrichPage({ imageBytes: Buffer.from('img'), mimeType: 'image/png', fragments: fragList }),
      (err: unknown) => err instanceof AiError && err.code === ErrorCodes.AI_RESPONSE_INVALID,
    );
  });
});
