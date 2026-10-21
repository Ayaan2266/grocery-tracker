import assert from "node:assert/strict";
import { test } from "node:test";

import { photoUrl } from "./images.ts";

// As the live API sent it on 2026-10-21, and as the nightly run stores it.
const STORED = "https://digital.loblaws.ca/PCX/21425018_EA/en/1/21425018_en_1_400.png";

test("a stored link is resized by its file name", () => {
  assert.equal(photoUrl(STORED, 120), "https://digital.loblaws.ca/PCX/21425018_EA/en/1/21425018_en_1_120.png");
  assert.equal(photoUrl(STORED, 800), "https://digital.loblaws.ca/PCX/21425018_EA/en/1/21425018_en_1_800.png");
  assert.equal(photoUrl(STORED, 400), STORED);
});

test("only the size at the very end is swapped", () => {
  // 400 also appears in the product code here; only the suffix changes.
  const url = "https://digital.loblaws.ca/PCX/20400400_EA/en/1/20400400_en_1_400.png";
  assert.equal(photoUrl(url, 250), "https://digital.loblaws.ca/PCX/20400400_EA/en/1/20400400_en_1_250.png");
});

test("a link in another shape is used as it is", () => {
  const other = "https://images.example.ca/products/123.jpg";
  assert.equal(photoUrl(other, 120), other);
});

test("no link, or anything but https, is no photo", () => {
  assert.equal(photoUrl(null, 120), null);
  assert.equal(photoUrl(undefined, 120), null);
  assert.equal(photoUrl("", 120), null);
  assert.equal(photoUrl("http://digital.loblaws.ca/a_400.png", 120), null);
  assert.equal(photoUrl("javascript:alert(1)", 120), null);
  assert.equal(photoUrl("//digital.loblaws.ca/a_400.png", 120), null);
});
