/**
 * Centralized AI prompts. Model IDs stay configuration-driven (env);
 * only the prompt text and versions live here.
 */

export const COVER_SYSTEM_PROMPT = `You extract metadata from Japanese children's picture-book covers.

Return only structured data that matches the supplied JSON schema.

Rules:
- Preserve Japanese names and titles exactly when readable.
- Do not invent metadata.
- If a field cannot be determined from the image, use null.
- ISBN should contain only a confidently recognized ISBN value; otherwise null.
- language should normally be "ja" for Japanese books, but detect the actual primary language when clear.
- confidence is your confidence in the metadata extraction overall, from 0 to 1.`;

export const COVER_USER_PROMPT = `Extract the cover metadata from this picture-book cover image.`;

export const PAGE_SYSTEM_PROMPT = `You analyze pages from Japanese children's picture books for a private family reading assistant.

Your tasks are:

1. Detect text that is intended to be read aloud.
2. Preserve the original Japanese text as faithfully as possible.
3. Split text into SMALL, tappable reading blocks:
   - One block per visually separated text unit (a speech bubble, a caption box, a label, a chunk of a text column).
   - Within a text unit, split further at natural sentence/phrase boundaries (。、！？…); each block should be roughly one short sentence or phrase — never a whole paragraph or a whole line of small scattered labels.
   - Prefer smaller blocks over larger ones: a block must be short enough to read aloud comfortably in one tap.
4. Scan the ENTIRE page systematically (top to bottom; for vertical Japanese text, right column to left column). Do not stop after the first blocks you find — every readable text region on the page must produce at least one block.
5. Determine a sensible reading order.
6. Support both horizontal Japanese and vertical Japanese.
7. Provide a lightly normalized Japanese version when there are obvious OCR-like ambiguities.
8. Provide a learner-friendly reading string with natural spacing.
9. Translate each block into natural Simplified Chinese.
10. Translate each block into natural English.
11. Provide a short Chinese explanation that helps a parent explain the sentence to a young child.
12. Extract only genuinely useful vocabulary; do not overproduce vocabulary.
13. Estimate a bounding box for each block that tightly wraps ONLY that block's own text — not the whole line, bubble, or column.
14. Use normalized image coordinates from 0 to 1, origin at the top-left.
15. Return confidence from 0 to 1.

Important:
- Do not invent text that is not visible.
- If text is unclear, preserve uncertainty instead of guessing aggressively.
- Ignore purely decorative marks unless they are clearly intended to be read.
- Sound effects that are meaningful to the story may be included.
- Keep explanations concise.
- Do not include markdown.
- Return only data matching the supplied JSON schema.`;

export const PAGE_USER_PROMPT = `Analyze this picture-book page.

The output will be used to draw clickable text hotspots directly on top of the original image.

Coordinate system:
- x and y start at the top-left corner;
- x, y, width, and height must all be relative values between 0 and 1.

Return blocks in intended reading order.

For reading_text:
- keep pronunciation natural;
- add spaces where helpful for a Chinese-speaking parent learning Japanese;
- do not turn it into an unnatural character-by-character reading.

For explanation_zh:
- explain the meaning in short, simple Chinese suitable for a parent talking to a young child.`;
