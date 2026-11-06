-- 0022_search_in_stock_first.sql
-- Search lists what is in stock first.
--
-- 0020 sorts each tier of matches by price, so a listing the store shows as
-- out of stock could be the first result: "milk" opened on a 237 ml carton
-- that Loblaws Markham did not have. Within each tier, in-stock listings now
-- come first and out-of-stock ones after them, each still cheapest first (or
-- best value first). Nothing is hidden; the row still says "Out of stock".
--
-- Only search_products changes; everything else is 0020's and 0021's.

BEGIN;

CREATE OR REPLACE FUNCTION search_products(
    search_term text,
    store_ids integer[] DEFAULT NULL,
    sort_by text DEFAULT 'price',
    max_rows integer DEFAULT 61
) RETURNS SETOF product_latest_price
LANGUAGE plpgsql STABLE
SET search_path FROM CURRENT
AS $$
DECLARE
    words text[] := search_words(search_term);
    tokens text[] := ARRAY(
        SELECT t FROM regexp_split_to_table(lower(trim(coalesce(search_term, ''))), '\s+') AS t
         WHERE t <> '');
    filters text[] := '{}';
    token text;
    word text;
BEGIN
    IF cardinality(tokens) = 0 THEN
        RETURN;
    END IF;

    -- One ILIKE per word, written out as literals so the planner can take
    -- each to the trigram index on products.raw_name (0004).
    FOREACH token IN ARRAY tokens LOOP
        IF token ~ '[[:digit:]]' THEN
            filters := filters || format(
                'replace(lower(v.raw_name || '' '' || coalesce(v.package_size, '''')), '' '', '''') LIKE %L',
                '%' || search_like_escape(token) || '%');
        ELSE
            FOREACH word IN ARRAY search_words(token) LOOP
                filters := filters || format(
                    'v.raw_name ILIKE %L', '%' || search_like_escape(search_stem(word)) || '%');
            END LOOP;
        END IF;
    END LOOP;
    IF cardinality(filters) = 0 THEN
        -- Nothing but punctuation and stopwords: the whole term, as before.
        filters := ARRAY[format(
            'v.raw_name ILIKE %L', '%' || search_like_escape(trim(search_term)) || '%')];
    END IF;

    RETURN QUERY EXECUTE format(
        'SELECT v.* FROM product_latest_price v
          WHERE %s AND ($1 IS NULL OR v.store_id = ANY ($1))
          ORDER BY search_tier(v.raw_name, v.brand, $2),
                   NOT v.in_stock,
                   CASE WHEN $3 = ''value'' THEN v.comparison_unit END ASC NULLS LAST,
                   CASE WHEN $3 = ''value'' THEN v.unit_price_cents END ASC NULLS LAST,
                   v.price_cents, v.product_id
          LIMIT $4',
        array_to_string(filters, ' AND '))
    USING store_ids, words, sort_by, least(greatest(coalesce(max_rows, 61), 1), 601);
END
$$;

COMMIT;
