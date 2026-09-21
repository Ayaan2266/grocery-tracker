-- 0001_init.sql
-- Core schema. Run against Supabase Postgres.
--
-- Design note: price_observations is append-only. Nothing in the application
-- ever updates a historical price. The only ON CONFLICT clause in the whole
-- project targets (product_id, observed_on) and exists so that re-running a
-- failed ingest on the same day is idempotent rather than duplicating rows.

CREATE TABLE retailers (
    id             SERIAL PRIMARY KEY,
    name           TEXT NOT NULL,
    banner_slug    TEXT NOT NULL UNIQUE,
    parent_company TEXT NOT NULL
);

CREATE TABLE stores (
    id          SERIAL PRIMARY KEY,
    retailer_id INTEGER NOT NULL REFERENCES retailers (id),
    -- The upstream PCX storeId. Text, not integer: it is an opaque code.
    store_code  TEXT NOT NULL,
    label       TEXT,
    postal_code TEXT,
    lat         DOUBLE PRECISION,
    lng         DOUBLE PRECISION,
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (retailer_id, store_code)
);

CREATE TABLE products (
    id           SERIAL PRIMARY KEY,
    store_id     INTEGER NOT NULL REFERENCES stores (id),
    -- The `code` field from the API, e.g. "20188873_EA". Natural key within a
    -- retailer. Not portable across retailers -- that is what match.py is for.
    retailer_sku TEXT NOT NULL,
    raw_name     TEXT NOT NULL,
    brand        TEXT,
    package_size TEXT,
    size_value   NUMERIC,
    size_unit    TEXT,
    first_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (store_id, retailer_sku)
);

CREATE TABLE price_observations (
    id                 BIGSERIAL PRIMARY KEY,
    product_id         INTEGER NOT NULL REFERENCES products (id),
    price_cents        INTEGER,
    -- From the API's wasPrice. Non-null means the item was on sale that day.
    was_price_cents    INTEGER,
    unit_price_cents   INTEGER,
    comparison_unit    TEXT,
    comparison_quantity NUMERIC,
    -- "api" when comparisonPrices supplied it, "derived" when normalize.py
    -- computed it from packageSize, "none" when neither worked. Keeping this
    -- means a derived-value bug can be found and corrected later without
    -- re-deriving the whole table.
    unit_price_source  TEXT NOT NULL DEFAULT 'none',
    in_stock           BOOLEAN NOT NULL DEFAULT TRUE,
    observed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    observed_on        DATE NOT NULL,
    UNIQUE (product_id, observed_on)
);

-- The query the whole app is built on: one product's history, newest first.
CREATE INDEX idx_observations_product_date
    ON price_observations (product_id, observed_on DESC);

-- "What was everything at this store on this day" -- powers the basket view.
CREATE INDEX idx_observations_date ON price_observations (observed_on);

CREATE INDEX idx_products_store ON products (store_id);

INSERT INTO retailers (name, banner_slug, parent_company) VALUES
    ('No Frills', 'nofrills', 'Loblaw Companies Limited'),
    ('Real Canadian Superstore', 'superstore', 'Loblaw Companies Limited'),
    ('Loblaws', 'loblaw', 'Loblaw Companies Limited');

INSERT INTO stores (retailer_id, store_code, label) VALUES
    (1, '3131', 'No Frills - Vaughan'),
    (2, '1516', 'Real Canadian Superstore');
