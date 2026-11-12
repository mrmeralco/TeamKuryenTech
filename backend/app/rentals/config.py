"""Configurable SmartWatts business tiers.

Prices and limits are read from the environment so they can change without a
code release. Real payment collection is intentionally NOT implemented: the
Rentals subscription can only be activated manually by a SmartWatts operator
(platform admin) after an offline/approved payment process.
"""

import os
from dataclasses import dataclass


def _int_env(name: str, default: int, minimum: int = 0) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as error:
        raise RuntimeError(f"{name} must be an integer.") from error
    if value < minimum:
        raise RuntimeError(f"{name} must be at least {minimum}.")
    return value


@dataclass(frozen=True)
class RentalsConfig:
    # Tier 2: SmartWatts Rentals — proposed ₱299 per property per month, up to 10 units.
    price_centavos_per_property_month: int = 29900
    unit_limit_per_property: int = 10
    currency: str = "PHP"
    trial_days: int = 0
    invitation_ttl_hours: int = 168
    reading_tolerance_days: int = 3
    max_bill_period_days: int = 62

    @classmethod
    def from_env(cls) -> "RentalsConfig":
        return cls(
            price_centavos_per_property_month=_int_env("RENTALS_PRICE_CENTAVOS", 29900, 0),
            unit_limit_per_property=_int_env("RENTALS_UNIT_LIMIT", 10, 1),
            currency=os.getenv("RENTALS_CURRENCY", "PHP").strip() or "PHP",
            trial_days=_int_env("RENTALS_TRIAL_DAYS", 0, 0),
            invitation_ttl_hours=_int_env("RENTALS_INVITATION_TTL_HOURS", 168, 1),
            reading_tolerance_days=_int_env("RENTALS_READING_TOLERANCE_DAYS", 3, 0),
            max_bill_period_days=_int_env("RENTALS_MAX_BILL_PERIOD_DAYS", 62, 1),
        )

    def plan_info(self) -> dict:
        return {
            "tiers": [
                {
                    "id": "personal",
                    "tier": 1,
                    "name": "SmartWatts Personal",
                    "priceCentavos": 0,
                    "billingInterval": None,
                    "description": "Free forever household electricity savings.",
                },
                {
                    "id": "rentals",
                    "tier": 2,
                    "name": "SmartWatts Rentals",
                    "priceCentavos": self.price_centavos_per_property_month,
                    "billingInterval": "property_month",
                    "unitLimit": self.unit_limit_per_property,
                    "description": "Transparent rental electricity management. Tenants are never charged a SmartWatts fee.",
                },
            ],
            "currency": self.currency,
            "trialDays": self.trial_days,
            "paymentsEnabled": False,
            "pricingStatus": "proposed",
            "notice": (
                "Online payment collection is not enabled. Rentals subscriptions are activated manually by "
                "SmartWatts staff. Tenant billing workflows require legal and regulatory review before production use."
            ),
        }
