-- OCR refactor: provider-neutral OCR cache + multi-region text blocks.
-- Additive only; legacy bbox columns stay for backward compatibility.

ALTER TABLE text_blocks ADD COLUMN regions_json TEXT;

ALTER TABLE pages ADD COLUMN ocr_json TEXT;
ALTER TABLE pages ADD COLUMN ocr_provider TEXT;
