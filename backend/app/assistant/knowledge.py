"""Approved, non-private knowledge for the assistant (retrieval-augmented, no embeddings).

Sources: the public Help & Support FAQ (knowledge/faq.json, shared with the website) and
SmartWatts feature guides below. No user records or conversations are ever indexed here.
Retrieved text is reference material only: it never authorizes tools or overrides instructions.
"""

from __future__ import annotations

import json
import math
import os
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

GUIDES = [
    ("guide-labels", "How SmartWatts labels numbers",
     "Actual readings are meter register values someone recorded. Bill-derived amounts come from bills the user or owner entered. "
     "Estimates are calculated from appliance wattage and usage hours. Simulations show what-if changes. "
     "Shared-meter allocations are agreed shares, not measurements of a unit. SmartWatts does not connect to meters or utility systems."),
    ("guide-appliance-estimate", "How appliance energy is estimated",
     "Monthly kWh = watts × quantity × hours per day × (days per week ÷ 7) × 30.4375 ÷ 1000. "
     "Appliances with an energy label use the manufacturer's tested kWh per month instead. Peso estimates use the average cost per kWh from the latest bill."),
    ("guide-readings", "Meter readings and interval consumption",
     "A meter reading is the cumulative register value on a date. Consumption for an interval is the later reading minus the earlier reading. "
     "Readings cannot go backwards; if a meter is replaced, the old meter is retired and a new one is registered. Flags highlight unusual intervals for review."),
    ("guide-statements", "Rental statements",
     "Owners record a utility bill, generate draft statements, mark them reviewed, then publish them. Tenants only see published statements. "
     "Corrections create a new version. Statements require legal and regulatory review before production use."),
    ("guide-shared-meters", "Shared meters",
     "A shared meter measures several units together. SmartWatts never invents per-unit kWh for it. Tenants are charged only through a written allocation agreement, "
     "and those charges are labelled as allocations, not measurements."),
    ("guide-subscription", "SmartWatts Rentals subscription",
     "SmartWatts Personal is free. SmartWatts Rentals is a proposed monthly subscription per property with up to 10 units. Owners can set up drafts for free and request activation. "
     "SmartWatts staff approve activation after verifying payment outside the app or for an authorized grant. Tenants never pay SmartWatts. Online payment is not enabled."),
    ("guide-coins", "Watts Coins",
     "Watts Coins come from daily quests, the 7-day check-in streak, and a verified decrease in monthly kWh from uploaded bills. Coins are locked until a bill payment or renewal window "
     "and expire three months after they are earned. Completing an in-app activity is not proof of physical electricity savings."),
]

_TOKEN = re.compile(r"[a-z0-9]+")
_STOP = {"the", "a", "an", "is", "are", "my", "i", "to", "of", "and", "or", "in", "on", "for", "what", "how", "why", "do", "does", "can", "it", "this", "with", "be", "me"}


@dataclass(frozen=True)
class Snippet:
    id: str
    title: str
    text: str


def _tokens(text: str) -> list[str]:
    return [t for t in _TOKEN.findall(text.lower()) if t not in _STOP and len(t) > 1]


def _faq_path() -> Path:
    override = os.getenv("SMARTWATTS_KNOWLEDGE_DIR", "").strip()
    root = Path(override) if override else Path(__file__).resolve().parents[3] / "knowledge"
    return root / "faq.json"


@lru_cache(maxsize=1)
def corpus() -> tuple[Snippet, ...]:
    docs = [Snippet(doc_id, title, text) for doc_id, title, text in GUIDES]
    try:
        faq = json.loads(_faq_path().read_text(encoding="utf-8"))
        for category in faq.get("categories", []):
            for index, (question, answer) in enumerate(category.get("items", [])):
                docs.append(Snippet(f"faq-{category.get('id', 'x')}-{index}", question, answer))
    except (OSError, ValueError, TypeError):
        pass  # The guides still work if the FAQ file is not deployed with the API.
    return tuple(docs)


def retrieve(query: str, k: int = 3) -> list[Snippet]:
    """BM25-style lexical ranking over the small approved corpus."""
    docs = corpus()
    query_terms = set(_tokens(query))
    if not query_terms or not docs:
        return []
    tokenized = [_tokens(f"{d.title} {d.title} {d.text}") for d in docs]
    avg_len = sum(len(t) for t in tokenized) / len(tokenized)
    scores = []
    for doc, terms in zip(docs, tokenized):
        score = 0.0
        for term in query_terms:
            df = sum(1 for t in tokenized if term in t)
            tf = terms.count(term)
            if not tf:
                continue
            idf = math.log(1 + (len(docs) - df + 0.5) / (df + 0.5))
            score += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * len(terms) / avg_len))
        if score > 0:
            scores.append((score, doc))
    scores.sort(key=lambda item: item[0], reverse=True)
    return [doc for score, doc in scores[:k] if score >= 1.0]
