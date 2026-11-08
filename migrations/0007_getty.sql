-- Getty Images royalty statements (monthly TSV exports), isolated from the Flickr catalog
CREATE TABLE getty_sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  royalty_month TEXT NOT NULL,      -- 'YYYY-MM' (statement month)
  sales_date TEXT,                  -- 'YYYY-MM-DD' when given
  asset_id TEXT NOT NULL,
  title TEXT,
  alt_name TEXT,                    -- "Alternate Asset Number": usually the original file name
  collection TEXT, product_type TEXT, region TEXT, territory TEXT, site TEXT, usage TEXT, file_size TEXT,
  license_fee REAL, royalty_rate REAL, royalty REAL,
  source_file TEXT
);
CREATE INDEX getty_sales_asset ON getty_sales(asset_id);
CREATE INDEX getty_sales_month ON getty_sales(royalty_month);

CREATE TABLE getty_imports (
  royalty_month TEXT PRIMARY KEY,
  source_file TEXT, rows INTEGER, imported_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- previews from the Getty API (optional key)
CREATE TABLE getty_assets (
  asset_id TEXT PRIMARY KEY,
  thumb_url TEXT, getty_title TEXT, fetched_at INTEGER
);
