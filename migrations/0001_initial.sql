PRAGMA foreign_keys = ON;

CREATE TABLE books (
  id TEXT PRIMARY KEY,
  title TEXT,
  subtitle TEXT,
  title_reading TEXT,
  author TEXT,
  illustrator TEXT,
  publisher TEXT,
  isbn TEXT,
  language TEXT NOT NULL DEFAULT 'ja',

  cover_image_key TEXT,
  cover_processed_image_key TEXT,
  cover_metadata_json TEXT,

  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN (
      'draft',
      'uploading',
      'processing',
      'ready',
      'failed'
    )),

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_books_updated_at
ON books(updated_at DESC);

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  book_id TEXT NOT NULL,

  page_number INTEGER NOT NULL,
  original_image_key TEXT NOT NULL,
  processed_image_key TEXT,

  width INTEGER,
  height INTEGER,
  mime_type TEXT,

  ocr_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (ocr_status IN (
      'pending',
      'processing',
      'ready',
      'failed'
    )),

  processing_error TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  FOREIGN KEY (book_id)
    REFERENCES books(id)
    ON DELETE CASCADE,

  UNIQUE(book_id, page_number)
);

CREATE INDEX idx_pages_book_page_number
ON pages(book_id, page_number);

CREATE INDEX idx_pages_book_status
ON pages(book_id, ocr_status);

CREATE TABLE text_blocks (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL,

  block_order INTEGER NOT NULL,

  original_text TEXT NOT NULL,
  normalized_text TEXT,
  reading_text TEXT,
  chinese_text TEXT,
  english_text TEXT,
  explanation_zh TEXT,

  vocabulary_json TEXT,

  orientation TEXT NOT NULL DEFAULT 'horizontal'
    CHECK (orientation IN (
      'horizontal',
      'vertical',
      'mixed',
      'unknown'
    )),

  bbox_x REAL NOT NULL
    CHECK (bbox_x >= 0.0 AND bbox_x <= 1.0),

  bbox_y REAL NOT NULL
    CHECK (bbox_y >= 0.0 AND bbox_y <= 1.0),

  bbox_width REAL NOT NULL
    CHECK (bbox_width >= 0.0 AND bbox_width <= 1.0),

  bbox_height REAL NOT NULL
    CHECK (bbox_height >= 0.0 AND bbox_height <= 1.0),

  confidence REAL
    CHECK (
      confidence IS NULL
      OR (confidence >= 0.0 AND confidence <= 1.0)
    ),

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  FOREIGN KEY (page_id)
    REFERENCES pages(id)
    ON DELETE CASCADE,

  UNIQUE(page_id, block_order)
);

CREATE INDEX idx_text_blocks_page_order
ON text_blocks(page_id, block_order);

CREATE TABLE audio_assets (
  id TEXT PRIMARY KEY,
  block_id TEXT NOT NULL,

  language TEXT NOT NULL
    CHECK (language IN ('ja', 'zh', 'en')),

  voice TEXT NOT NULL,
  speed REAL NOT NULL DEFAULT 1.0,

  audio_key TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'audio/mpeg',

  text_hash TEXT NOT NULL,

  created_at TEXT NOT NULL,

  FOREIGN KEY (block_id)
    REFERENCES text_blocks(id)
    ON DELETE CASCADE,

  UNIQUE(block_id, language, voice, speed, text_hash)
);

CREATE INDEX idx_audio_assets_block
ON audio_assets(block_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,

  session_token_hash TEXT NOT NULL UNIQUE,

  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT,

  user_agent TEXT
);

CREATE INDEX idx_sessions_expires_at
ON sessions(expires_at);

CREATE TABLE processing_jobs (
  id TEXT PRIMARY KEY,

  entity_type TEXT NOT NULL
    CHECK (entity_type IN ('cover', 'page', 'audio')),

  entity_id TEXT NOT NULL,

  status TEXT NOT NULL
    CHECK (status IN (
      'pending',
      'running',
      'success',
      'failed'
    )),

  payload_json TEXT,
  error_code TEXT,
  error_message TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_processing_jobs_entity
ON processing_jobs(entity_type, entity_id);

CREATE INDEX idx_processing_jobs_status
ON processing_jobs(status, updated_at);
