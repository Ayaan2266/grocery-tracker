import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_ITEMS, MAX_QUANTITY, adjustQuantity, parseBasket, serializeBasket } from "./basket.ts";
import { parseProductId } from "./product-id.ts";

test("basket cookies round-trip with quantity and distinct-item limits", () => {
  const basket = parseBasket("12:1,40:2,99:1000");
  assert.deepEqual([...basket], [[12, 1], [40, 2], [99, MAX_QUANTITY]]);
  assert.deepEqual(parseBasket(serializeBasket(basket)), basket);
  const large = Array.from({ length: MAX_ITEMS + 10 }, (_, i) => `${i + 1}:1`).join(",");
  assert.equal(parseBasket(large).size, MAX_ITEMS);
});

test("invalid cookie entries cannot coerce IDs or smuggle extra fields", () => {
  assert.deepEqual([...parseBasket("1:2:3,1e3:1,0x10:1,2147483648:1,4:1e2,5:0,6:-1,7:2")], [[7, 2]]);
});

test("product IDs must fit a database integer and come from a plain decimal string", () => {
  for (const invalid of [null, "", " ", "-1", "0", "1.5", "1e3", "2147483648", {}, 1]) {
    assert.equal(parseProductId(invalid), null);
  }
  assert.equal(parseProductId("2147483647"), 2147483647);
});

test("quantity controls cannot add absent lines or bypass caps", () => {
  const basket = parseBasket("1:1,2:99");
  adjustQuantity(basket, 3, 1);
  adjustQuantity(basket, 1, 99);
  adjustQuantity(basket, 2, 1);
  assert.deepEqual([...basket], [[1, 1], [2, 99]]);
  adjustQuantity(basket, 1, -1);
  assert.deepEqual([...basket], [[2, 99]]);
});
