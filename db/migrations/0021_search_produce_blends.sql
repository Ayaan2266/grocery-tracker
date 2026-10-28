-- 0021_search_produce_blends.sql
-- Baby food and smoothies stop ranking as the fruit they start with.
--
-- 0020 takes a name's head noun from before its first comma, so "Apple,
-- Paula Red" is an apple. Blends are written the same way: "Banana, Sweet
-- Potato Blueberry" and "Apple, Banana, Kale with Hemp Seed" ranked as
-- bananas and apples, ahead of the fruit itself. When the part before the
-- comma is a single fruit or vegetable and another one follows, the name is
-- a list, and like "Banana, Sweet Potato, and Blueberry Baby Food" it is
-- named for what comes last. "Greek Yogurt, Banana" is still yogurt: yogurt
-- is not produce.
--
-- Only search_tier changes; everything else is 0020's.

BEGIN;

CREATE OR REPLACE FUNCTION search_tier(raw_name text, brand text, words text[]) RETURNS integer
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
        'reduced|regular|mf|salted|unsalted|boneless|skinless|mild|old|aged|sharp|'
        -- how it is raised or sold
        'organic|kosher|grass|fed|range|fresh|natural|premium|original|classic|plain|'
        'product|shelf|stable|brown|white|run|pasture|raised|grade|omega|plus|bunch|sliced|'
        -- size and packaging
        'large|medium|small|extra|jumbo|xl|size|family|club|value|bulk|pack|pk|multipack|'
        'count|ct|bag|jug|carton|bottle|can|case|box|tray|tub|jar|pouch'
        ')\M';
    -- Fruit and vegetables that baby food and smoothies are blended from.
    produce constant text := '\m('
        'apple|apricot|avocado|banana|bean|beet|blackberry|blueberry|broccoli|carrot|'
        'cauliflower|cherry|coconut|corn|cranberry|fig|grape|guava|kale|kiwi|lemon|lime|'
        'mango|orange|papaya|pea|peach|pear|pineapple|plum|potato|prune|pumpkin|raspberry|'
        'spinach|squash|strawberry|tomato|zucchini'
        ')\M';
    list boolean;
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
    -- an almond milk alternative. Not a comma that starts a list, though:
    -- "Banana, Sweet Potato, and Blueberry Baby Food" is baby food, and so
    -- is "Banana, Sweet Potato Blueberry", a fruit followed by more fruit.
    -- "Apple, Paula Red" and "Greek Yogurt, Banana" are not lists. A marker
    -- word stands in for the boundary so the name is folded once, not once
    -- for each part.
    list := raw_name ~ ',.*\s(and|&|\+)\s'
        OR (raw_name LIKE '%,%'
            AND btrim(regexp_replace(search_text(split_part(raw_name, ',', 1)), descriptors, ' ', 'g'))
                ~ ('^(sweet )?' || produce || '$')
            AND search_text(substr(raw_name, strpos(raw_name, ',') + 1)) ~ produce);
    folded := search_text(regexp_replace(
        lower(raw_name),
        CASE WHEN list THEN '(\(|\s-\s|\s(with|in|for|made)\s)'
             ELSE '(,|\(|\s-\s|\s(with|in|for|made)\s)' END,
        ' qqheadend '));
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

    -- Cheese is named for its kind: "Mild Cheddar Cheese" is cheddar.
    IF cardinality(head_words) > 1 AND head_words[cardinality(head_words)] = 'cheese'
       AND head_words[cardinality(head_words) - 1] = wanted THEN
        head_words := head_words[1:cardinality(head_words) - 1];
    END IF;

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

COMMIT;
