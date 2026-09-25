-- 0010_add_zehrs_fortinos_maxi.sql
-- Three more banners, one store each, and the locations of all six.
--
-- Guessed codes for these banners returned HTTP 200 with zero results, which
-- looks exactly like a working store with nothing in stock, so none was added
-- until one could be proved. On 2026-09-25 `python -m ingest.stores discover`
-- listed every store of each banner from the storefront's own store list
-- (pickup-locations, see docs/data-sources.md) and canary-searched the three
-- nearest to Toronto. All nine returned products. One per banner is added:
--
--   zehrs/0552     Zehrs Uxbridge                 156 canary hits
--   fortinos/1436  Fortinos North York Lawrence   146
--   maxi/8711      Maxi Aylmer Vanier (Gatineau)  107
--
-- The same list gave the existing stores' locations, which had never been
-- recorded. Superstore 1516, the one store that banner has been ingested at,
-- is Kenaston in Winnipeg: the only one of the six outside Ontario and Quebec,
-- and why it carries Beatrice and Dairyland where the Ontario stores carry
-- Neilson. The labels now say where each store is.

BEGIN;

INSERT INTO retailers (name, banner_slug, parent_company) VALUES
    ('Zehrs',    'zehrs',    'Loblaw Companies Limited'),
    ('Fortinos', 'fortinos', 'Loblaw Companies Limited'),
    ('Maxi',     'maxi',     'Loblaw Companies Limited')
ON CONFLICT (banner_slug) DO NOTHING;

INSERT INTO stores (retailer_id, store_code, label, postal_code)
SELECT r.id, v.store_code, v.label, v.postal_code
  FROM (VALUES
           ('zehrs',    '0552', 'Zehrs - Uxbridge',                   'L9P 1N2'),
           ('fortinos', '1436', 'Fortinos - North York Lawrence',     'M6A 3B4'),
           ('maxi',     '8711', 'Maxi - Aylmer Vanier',               'J9J 3Z4')
       ) AS v (banner_slug, store_code, label, postal_code)
  JOIN retailers r ON r.banner_slug = v.banner_slug
ON CONFLICT (retailer_id, store_code) DO NOTHING;

UPDATE stores s
   SET label = v.label,
       postal_code = v.postal_code
  FROM (VALUES
           ('nofrills',   '3131', 'No Frills - Vaughan',                        'L4K 0C1'),
           ('superstore', '1516', 'Real Canadian Superstore - Winnipeg Kenaston', 'R3N 2A1'),
           ('loblaw',     '1032', 'Loblaws - Markham Bullock Drive',            'L3P 1W2')
       ) AS v (banner_slug, store_code, label, postal_code)
  JOIN retailers r ON r.banner_slug = v.banner_slug
 WHERE s.retailer_id = r.id
   AND s.store_code = v.store_code;

COMMIT;
