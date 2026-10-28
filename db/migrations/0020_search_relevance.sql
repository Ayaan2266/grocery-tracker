-- 0020_search_relevance.sql
-- Search that ranks what you asked for first, and forgives a typo.
--
-- Until now the search box was ILIKE '%term%', cheapest first. "milk" matched
-- 2,800 listings, and the cheapest were chocolate bars, milkshakes and
-- buttermilk, so the milk itself was pages down. A misspelling ("banaana")
-- matched nothing at all.
--
-- search_products ranks every match into one of four tiers, then applies the
-- chosen sort inside each tier:
--
--   0  the name is the thing searched for: "2% Milk", "Partly Skimmed Milk 2%
--      M.F.", "Lactose Free Homogenized Milk". Every search word is a whole
--      word of the name, the last one is the name's head noun, and every
--      other word is a descriptor (fat, size, packaging, organic, ...).
--   1  a kind of it: "Chocolate Milk", "Goat Milk 2%", "Evaporated Milk".
--      Same head noun, with other words that change what it is.
--      A search of two words or more also lands here when the name holds
--      them as written: "milk chocolate" finds "Milk Chocolate Bar".
--   2  it is in the name, but the name is something else: "Milk Chocolate
--      Bar", "Oat Milk Alternative, Original", "Iced Coffee, Add to Milk".
--   3  only inside a longer word: "Buttermilk", "Milkshake", "Caramilk".
--
-- The head noun is the last word of the name before the first comma,
-- parenthesis, " - " or "with", once descriptors are set aside. That is how
-- the stores write their names: "Almond Milk Alternative, Vanilla" is an
-- alternative, "Milk Chocolate Bar With A Milky Filling" is a bar.
--
-- Plurals fold the same way ingest/match.py's singular() folds them, so
-- "bananas" finds "Banana Chips" and "banana" finds "Bananas".
--
-- search_suggestion corrects the words that appear in no product name to the
-- closest word that does, by trigram similarity: "banaana" -> "banana". The
-- site asks for it only when a search finds nothing.
--
-- Functions only: no table changes, no data changes. The site falls back to
-- the old ILIKE search while this is not applied, so it can go in before or
-- after the code that uses it.
--
-- SET search_path FROM CURRENT, not '': these call each other and pg_trgm,
-- which lives in `extensions` on Supabase and `public` on a plain Postgres,
-- so the names cannot be qualified. Fixing the path at creation still gives
-- Supabase's security advisor the fixed search_path it asks for.

BEGIN;

-- The words of a name or a search, lower-cased, folded and joined by single
-- spaces. Numbers, sizes ("4L", "3.25%"), single letters ("M.F.") and
-- stopwords are not words; numbers are left to the ILIKE filter.
--
-- Plurals fold like ingest/match.py singular(). Only consistency matters:
-- equal words must fold equal, not to a real word ("cookies" and "cookie"
-- are both "cooky"). It works on the whole phrase at once, a regular
-- expression per rule, because one call per word made a search for "milk"
-- (3,000 listings) take a second longer.
CREATE FUNCTION search_text(phrase text) RETURNS text
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
SET search_path FROM CURRENT
AS $$
DECLARE
    s text := regexp_replace(lower(coalesce(phrase, '')), '[^[:alnum:]]+', ' ', 'g');
BEGIN
    s := regexp_replace(s,
        '\m([[:alnum:]]*[[:digit:]][[:alnum:]]*|[[:alpha:]]|an|and|by|for|in|made|of|on|or|the|to|with)\M',
        ' ', 'g');
    s := regexp_replace(s, '\m([[:alpha:]]+(ch|sh|ss|x|z))es\M', '\1', 'g');   -- peaches, boxes
    s := regexp_replace(s, '\m([[:alpha:]]{2,}[^[:space:]isu])s\M', '\1', 'g');  -- bananas, not glass
    s := regexp_replace(s, '\m([[:alpha:]]{2,})ie\M', '\1y', 'g');              -- cookie, not pie
    s := regexp_replace(s, '\m([[:alpha:]]{3,})oe\M', '\1o', 'g');              -- tomatoe(s)
    RETURN btrim(regexp_replace(s, '\s+', ' ', 'g'));
END
$$;

CREATE FUNCTION search_words(phrase text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path FROM CURRENT
AS $$
SELECT string_to_array(search_text(phrase), ' ')
$$;

-- The tier described at the top, for one listing and the folded search words.
CREATE FUNCTION search_tier(raw_name text, brand text, words text[]) RETURNS integer
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
SET search_path FROM CURRENT
AS $$
DECLARE
    -- Words that say which one, not what it is. They never count against a
    -- match and are never the head noun. Folded, like everything compared.
    descriptors constant text := '\m('
        -- fat and processing
        'skim|skimmed|partly|partially|whole|homogenized|homogenised|filtered|fine|'
        'microfiltered|ultrafiltered|ultra|enriched|lactose|free|fat|low|light|lite|'
        'reduced|regular|mf|salted|unsalted|boneless|skinless|'
        -- how it is raised or sold
        'organic|kosher|grass|fed|range|fresh|natural|premium|original|classic|plain|'
        'product|shelf|stable|brown|white|run|pasture|raised|grade|omega|plus|bunch|sliced|'
        -- size and packaging
        'large|medium|small|extra|jumbo|xl|size|family|club|value|bulk|pack|pk|multipack|'
        'count|ct|bag|jug|carton|bottle|can|case|box|tray|tub|jar|pouch'
        ')\M';
    folded text;
    name_words text[];
    head_words text[];
    brand_word text;
    wanted text;
BEGIN
    IF cardinality(words) = 0 THEN
        RETURN 0;
    END IF;

    -- The part of the name that says what it is ends at the first comma,
    -- parenthesis, " - " or "with": "Almond Milk Alternative, Original" is
    -- an almond milk alternative. A marker word stands in for the boundary
    -- so the name is folded once, not once for each part.
    folded := search_text(
        regexp_replace(lower(raw_name), '(,|\(|\s-\s|\s(with|in|for|made)\s)', ' qqheadend '));
    name_words := array_remove(string_to_array(folded, ' '), 'qqheadend');
    IF NOT words <@ name_words THEN
        RETURN 3;
    END IF;
    head_words := string_to_array(btrim(regexp_replace(
        regexp_replace(split_part(folded, 'qqheadend', 1), descriptors, ' ', 'g'),
        '\s+', ' ', 'g')), ' ');
    IF cardinality(head_words) = 0 THEN
        -- Nothing before the boundary but descriptors: "(KP) Almond Milk".
        head_words := string_to_array(btrim(regexp_replace(
            regexp_replace(replace(folded, 'qqheadend', ' '), descriptors, ' ', 'g'),
            '\s+', ' ', 'g')), ' ');
    END IF;

    -- The searched-for thing is the last search word that is not a
    -- descriptor: "large eggs" is a search for eggs.
    FOR i IN REVERSE cardinality(words)..1 LOOP
        IF words[i] !~ descriptors THEN
            wanted := words[i];
            EXIT;
        END IF;
    END LOOP;

    IF wanted IS NOT NULL AND head_words[cardinality(head_words)] IS DISTINCT FROM wanted THEN
        IF cardinality(words) > 1
           AND ' ' || array_to_string(name_words, ' ') || ' '
               LIKE '% ' || array_to_string(words, ' ') || ' %' THEN
            RETURN 1;
        END IF;
        RETURN 2;
    END IF;

    -- The brand is set aside unless it was searched for: "Natrel Plus 2%
    -- Milk" is milk, but a search for "natrel" still wants Natrel.
    IF NOT head_words <@ words AND brand IS NOT NULL THEN
        FOREACH brand_word IN ARRAY search_words(brand) LOOP
            IF brand_word <> ALL (words) THEN
                head_words := array_remove(head_words, brand_word);
            END IF;
        END LOOP;
    END IF;
    IF head_words <@ words THEN
        RETURN 0;
    END IF;
    RETURN 1;
END
$$;

-- What a search word must contain to be any form of it: "berries" folds to
-- "berry", and both "berry" and "berries" contain "berr".
CREATE FUNCTION search_stem(word text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path FROM CURRENT
AS $$
SELECT CASE WHEN length(f) > 3 AND f LIKE '%y' THEN left(f, -1) ELSE f END
  FROM (SELECT search_text(word) AS f) folded
$$;

-- `%`, `_` and `\` are ILIKE syntax; a search for "50%" means fifty percent.
CREATE FUNCTION search_like_escape(fragment text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path FROM CURRENT
AS $$
SELECT regexp_replace(fragment, '([\\%_])', '\\\1', 'g')
$$;

-- One page of search results: best tier first, then cheapest, or best unit
-- price grouped by unit when sort_by is 'value', as the site always sorted.
-- Every word must appear in the name, in any order; a token with a digit in
-- it ("2%", "4L") must appear in the name or the package size. store_ids
-- limits it to those stores; null searches every store.
CREATE FUNCTION search_products(
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
                   CASE WHEN $3 = ''value'' THEN v.comparison_unit END ASC NULLS LAST,
                   CASE WHEN $3 = ''value'' THEN v.unit_price_cents END ASC NULLS LAST,
                   v.price_cents, v.product_id
          LIMIT $4',
        array_to_string(filters, ' AND '))
    USING store_ids, words, sort_by, least(greatest(coalesce(max_rows, 61), 1), 601);
END
$$;

-- The search with each word no product name contains replaced by the
-- closest word one does, or null when every word is found or nothing is
-- close. "banaana" -> "banana", "chocolat milkk" -> "chocolat milk" (a
-- prefix is found, so it is left alone).
CREATE FUNCTION search_suggestion(search_term text) RETURNS text
LANGUAGE plpgsql STABLE
SET search_path FROM CURRENT
-- `<%` below uses this as its cut-off. The default, 0.6, misses a doubled
-- letter in a short word ("banaana" against "Bananas" is 0.57).
SET pg_trgm.word_similarity_threshold = 0.4
AS $$
DECLARE
    tokens text[] := ARRAY(
        SELECT t FROM regexp_split_to_table(lower(trim(coalesce(search_term, ''))), '\s+') AS t
         WHERE t <> '');
    corrected text[] := '{}';
    changed boolean := false;
    token text;
    best text;
BEGIN
    FOREACH token IN ARRAY tokens LOOP
        best := NULL;
        IF token ~ '^[[:alpha:]]{3,}$'
           AND NOT EXISTS (
               SELECT 1 FROM products
                WHERE raw_name ILIKE '%' || search_like_escape(search_stem(token)) || '%')
        THEN
            -- Names that share a few trigrams with the word, then the word in
            -- them closest to it; the more listings use a word, the likelier
            -- it is the one meant.
            SELECT w INTO best
              FROM (SELECT lower(m[1]) AS w
                      FROM (SELECT raw_name FROM products
                             WHERE token <% raw_name
                             LIMIT 5000) named,
                           regexp_matches(named.raw_name, '([[:alpha:]]{3,})', 'g') AS m) words
             WHERE similarity(w, token) >= 0.4
             GROUP BY w
             ORDER BY max(similarity(w, token)) DESC, count(*) DESC, w
             LIMIT 1;
        END IF;
        IF best IS NOT NULL THEN
            corrected := corrected || best;
            changed := true;
        ELSE
            corrected := corrected || token;
        END IF;
    END LOOP;
    RETURN CASE WHEN changed THEN array_to_string(corrected, ' ') END;
END
$$;

-- Callable through the API with the anon key, like the views. They read
-- through product_latest_price and products, so RLS still applies.
REVOKE ALL ON FUNCTION search_products(text, integer[], text, integer), search_suggestion(text)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION search_products(text, integer[], text, integer), search_suggestion(text)
    TO anon, authenticated;

COMMIT;
