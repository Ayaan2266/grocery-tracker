"""Pydantic models for the PCX search response.

Only the fields ingestion actually consumes are modelled. `extra="ignore"` is
deliberate: the upstream API is undocumented and adds fields without notice,
and a new field should never fail a nightly run.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class Money(BaseModel):
    model_config = ConfigDict(extra="ignore")

    value: float | None = None
    unit: str | None = None
    quantity: float | None = None
    type: str | None = None


class ComparisonPrice(BaseModel):
    """Already normalized by the API, typically to $/100g or $/100ml."""

    model_config = ConfigDict(extra="ignore")

    value: float | None = None
    unit: str | None = None
    quantity: float | None = None


class Prices(BaseModel):
    model_config = ConfigDict(extra="ignore")

    price: Money | None = None
    # Non-null only when the item is on sale. This is the sale flag; there is
    # no separate boolean to trust.
    wasPrice: Money | None = None
    comparisonPrices: list[ComparisonPrice] = []


class Product(BaseModel):
    model_config = ConfigDict(extra="ignore")

    code: str  # retailer SKU, e.g. "20188873_EA" -- natural key
    name: str
    brand: str | None = None
    packageSize: str | None = None
    stockStatus: str | None = None
    prices: Prices | None = None


class Pagination(BaseModel):
    model_config = ConfigDict(extra="ignore")

    totalResults: int = 0


class SearchResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    results: list[Product] = []
    pagination: Pagination = Pagination()
