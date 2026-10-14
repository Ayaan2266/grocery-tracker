-- 0015_label_nofrills_front_street.sql
-- Name No Frills 3643 by its street.
--
-- 0014 added it as "No Frills - Toronto M5A 4T9" because the storefront's
-- store list names it only "Rocco's NOFRILLS Toronto". It is the No Frills at
-- 200 Front Street East, at Princess Street: public store listings give that
-- address with the same postal code, M5A 4T9, and Princess Street is where
-- the store list's own coordinates (43.65142, -79.36595) put it.
--
-- The site reads the place from the label (web/src/lib/stores.ts storeArea),
-- so this is what visitors see. Only the label changes; prices are keyed by
-- store id, so the history is untouched.

BEGIN;

DO $$
DECLARE
    renamed integer;
BEGIN
    UPDATE stores s
       SET label = 'No Frills - Toronto Front Street East'
      FROM retailers r
     WHERE s.retailer_id = r.id
       AND r.banner_slug = 'nofrills'
       AND s.store_code = '3643';
    GET DIAGNOSTICS renamed = ROW_COUNT;
    IF renamed <> 1 THEN
        RAISE EXCEPTION 'expected to rename 1 store, renamed %', renamed;
    END IF;
END
$$;

COMMIT;
