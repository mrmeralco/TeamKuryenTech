import json
import os
import re
from typing import Annotated, Literal

import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

load_dotenv()

from .security import site  # noqa: E402
from .security.middleware import SecurityMiddleware  # noqa: E402
from .security.settings import load_security_settings  # noqa: E402
from .security.validation import validate_params  # noqa: E402

# Validated before anything else: production refuses to start with missing or weak secrets.
SECURITY = load_security_settings()

from .auth import AuthUser, require_user  # noqa: E402
from .advisor import AdvisorContext, compute_facts, deterministic_summary, system_prompt, unverified_figures  # noqa: E402
from .rentals.router import router as rentals_router  # noqa: E402
from .assistant.router import router as assistant_router  # noqa: E402
from .email_otp import router as email_otp_router  # noqa: E402
from .notifications.router import router as notifications_router  # noqa: E402

GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
GOOGLE_TRANSLATE_URL = "https://translation.googleapis.com/language/translate/v2"
MAX_MESSAGES = 12
MAX_TRANSLATION_STRINGS = 80
MAX_TRANSLATION_CHARACTERS = 25000
LanguageCode = Annotated[str, Field(pattern=r"^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$")]


class ChatMessage(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    role: Literal["user", "assistant"]
    text: str = Field(min_length=1, max_length=2000)


class ChatRequest(BaseModel):
    language: LanguageCode
    messages: list[ChatMessage] = Field(min_length=1, max_length=MAX_MESSAGES)
    # The signed-in user's own appliance/bill figures (optional). See app/advisor.py.
    context: AdvisorContext | None = None

    @model_validator(mode="after")
    def require_latest_user_message(self):
        if self.messages[-1].role != "user":
            raise ValueError("The latest chat message must be from the user.")
        return self


class ChatReply(BaseModel):
    reply: str
    # True when every peso/kWh/% figure in the reply matched a SmartWatts-computed fact.
    validated: bool = True
    facts: list[str] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)
    withheldFigures: list[str] = Field(default_factory=list)


class ApplianceVisionRequest(BaseModel):
    image_base64: str = Field(min_length=10, max_length=15_000_000)
    mime_type: str = Field(default="image/jpeg")

    @field_validator("mime_type")
    @classmethod
    def validate_mime_type(cls, value: str) -> str:
        clean = value.lower().strip()
        if clean not in {"image/jpeg", "image/jpg", "image/png", "image/webp"}:
            raise ValueError("Supported image formats are JPEG, PNG, and WebP.")
        return "image/jpeg" if clean == "image/jpg" else clean


class ApplianceVisionResponse(BaseModel):
    brand: str | None = None
    model: str | None = None
    appliance_type: str | None = None
    watts: float | None = None
    voltage: str | None = None
    frequency: str | None = None
    current: str | None = None
    tested_kwh_month: float | None = None
    tested_kwh_24h: float | None = None
    tested_kwh_year: float | None = None
    energy_efficiency_rating: float | None = None
    label_type: str = "UNKNOWN"
    raw_text: str | None = None
    evidence: str | None = None
    confidence: str = "medium"
    notes: str | None = None
    # "label" when read from a printed label, "object" when recognized from the appliance itself.
    identified_from: str | None = None
    # Visible size/variant that changes typical wattage, e.g. "16-inch stand fan", "55-inch TV", "1.5 HP".
    size_hint: str | None = None


class TranslationRequest(BaseModel):
    target: LanguageCode
    texts: list[str] = Field(min_length=1, max_length=MAX_TRANSLATION_STRINGS)

    @model_validator(mode="after")
    def validate_texts(self):
        if any(not text.strip() or len(text) > 5000 for text in self.texts):
            raise ValueError("Translation text must contain 1 to 5,000 characters.")
        if sum(map(len, self.texts)) > MAX_TRANSLATION_CHARACTERS:
            raise ValueError("A translation request may contain at most 25,000 characters.")
        return self


class TranslationResponse(BaseModel):
    translations: list[str]


# No interactive docs or OpenAPI schema in production: the API must not list its routes to strangers.
_docs = {} if not SECURITY.production else {"docs_url": None, "redoc_url": None, "openapi_url": None}
app = FastAPI(title="SmartWatts API", version="2.0.0", dependencies=[Depends(validate_params)], **_docs)
# Cross-origin access is only for local development (the Vite dev server). In production the site and the API
# share one origin, so no CORS origins are allowed unless ALLOWED_ORIGINS lists them explicitly.
_DEV_ORIGINS = "" if SECURITY.production else "http://localhost:5173,http://127.0.0.1:5173"
allowed_origins = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", _DEV_ORIGINS).split(",")
    if origin.strip() and origin.strip() != "*"
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT"],
    allow_headers=["Content-Type", "Authorization"],
)

# Added last, so it wraps everything else (including CORS): headers on every response, generic 500s.
app.add_middleware(SecurityMiddleware, settings=SECURITY)

app.include_router(rentals_router)
app.include_router(email_otp_router)
app.include_router(assistant_router)
app.include_router(notifications_router)


@app.get("/api/health")
async def health():
    return {"status": "ok"}


async def google_translation_request(method: str, *, params: dict[str, str], payload: dict | None = None):
    api_key = os.getenv("GOOGLE_TRANSLATE_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(status_code=503, detail="Google Cloud Translation is not configured on the server.")

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=5.0)) as client:
            response = await client.request(
                method,
                GOOGLE_TRANSLATE_URL,
                params={**params, "key": api_key},
                json=payload,
            )
    except httpx.TimeoutException as error:
        raise HTTPException(status_code=504, detail="Google Cloud Translation timed out. Please try again.") from error
    except httpx.RequestError as error:
        raise HTTPException(status_code=502, detail="Could not reach Google Cloud Translation.") from error

    if response.status_code in (401, 403):
        raise HTTPException(status_code=503, detail="Google Cloud Translation is unavailable for this server configuration.")
    if response.status_code == 400:
        raise HTTPException(status_code=400, detail="Google Cloud Translation rejected the language or text.")
    if response.is_error:
        raise HTTPException(status_code=502, detail="Google Cloud Translation returned an error.")

    try:
        result = response.json()
    except ValueError as error:
        raise HTTPException(status_code=502, detail="Google Cloud Translation returned an invalid response.") from error
    if not isinstance(result, dict):
        raise HTTPException(status_code=502, detail="Google Cloud Translation returned an invalid response.")
    return result


@app.get("/api/translate/languages")
async def translation_languages(_user: AuthUser = Depends(require_user)):
    result = await google_translation_request("GET", params={"target": "en"})
    data = result.get("data")
    languages = data.get("languages") if isinstance(data, dict) else None
    if not isinstance(languages, list):
        raise HTTPException(status_code=502, detail="Google Cloud Translation returned an invalid language list.")

    supported = [
        {"code": language["language"], "name": language["name"]}
        for language in languages
        if isinstance(language, dict)
        and isinstance(language.get("language"), str)
        and isinstance(language.get("name"), str)
    ]
    if not supported:
        raise HTTPException(status_code=502, detail="Google Cloud Translation returned an empty language list.")
    return {"languages": supported}


@app.post("/api/translate", response_model=TranslationResponse)
async def translate(request: TranslationRequest, _user: AuthUser = Depends(require_user)):
    result = await google_translation_request(
        "POST",
        params={},
        payload={"q": request.texts, "target": request.target, "format": "text"},
    )
    data = result.get("data")
    translated = data.get("translations") if isinstance(data, dict) else None
    if not isinstance(translated, list) or len(translated) != len(request.texts):
        raise HTTPException(status_code=502, detail="Google Cloud Translation returned an incomplete translation.")

    translations = [item.get("translatedText") for item in translated if isinstance(item, dict)]
    if len(translations) != len(request.texts) or not all(isinstance(text, str) for text in translations):
        raise HTTPException(status_code=502, detail="Google Cloud Translation returned an invalid translation.")
    return TranslationResponse(translations=translations)


@app.post("/api/chat", response_model=ChatReply)
async def chat(request: ChatRequest, _user: AuthUser = Depends(require_user)):
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(status_code=503, detail="The AI service is not configured on the server.")

    contents = [
        {
            "role": "model" if message.role == "assistant" else "user",
            "parts": [{"text": message.text}],
        }
        for message in request.messages
    ]
    facts, assumptions = compute_facts(request.context)
    payload = {
        "systemInstruction": {"parts": [{"text": system_prompt(request.language, facts, assumptions)}]},
        "contents": contents,
        "generationConfig": {"temperature": 0.3, "maxOutputTokens": 700},
    }

    model = os.getenv("GEMINI_MODEL", "gemini-3-flash-preview")
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(45.0, connect=10.0)) as client:
            response = await client.post(
                GEMINI_API_URL.format(model=model),
                headers={"x-goog-api-key": api_key},
                json=payload,
            )
    except httpx.TimeoutException as error:
        raise HTTPException(status_code=504, detail="The AI service timed out. Please try again.") from error
    except httpx.RequestError as error:
        raise HTTPException(status_code=502, detail="Could not reach the AI service. Please try again.") from error

    if response.is_error:
        raise HTTPException(status_code=502, detail="The AI service returned an error. Please try again later.")

    try:
        result = response.json()
    except ValueError as error:
        raise HTTPException(status_code=502, detail="The AI service returned an invalid response.") from error
    if not isinstance(result, dict):
        raise HTTPException(status_code=502, detail="The AI service returned an invalid response.")
    candidates = result.get("candidates")
    if not isinstance(candidates, list) or not candidates or not isinstance(candidates[0], dict):
        raise HTTPException(status_code=502, detail="The AI service returned an empty reply.")
    content = candidates[0].get("content")
    parts = content.get("parts") if isinstance(content, dict) else None
    if not isinstance(parts, list):
        raise HTTPException(status_code=502, detail="The AI service returned an empty reply.")
    reply = next(
        (part.get("text") for part in parts if isinstance(part, dict) and isinstance(part.get("text"), str)),
        None,
    )
    if not reply or not reply.strip():
        raise HTTPException(status_code=502, detail="The AI service returned an empty reply.")
    fact_texts = [fact.text for fact in facts]
    user_text = " ".join(message.text for message in request.messages if message.role == "user")
    withheld = unverified_figures(reply, facts, user_text)
    if withheld:
        # Never pass invented figures to the user: replace with the deterministic calculation.
        return ChatReply(reply=deterministic_summary(facts, assumptions), validated=False,
                         facts=fact_texts, assumptions=assumptions, withheldFigures=withheld)
    return ChatReply(reply=reply.strip(), facts=fact_texts, assumptions=assumptions)


@app.post("/api/ai/appliance-label", response_model=ApplianceVisionResponse)
async def analyze_appliance_label(request: ApplianceVisionRequest, _user: AuthUser = Depends(require_user)):
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="The AI vision service is not configured on the server. Please use local browser OCR or enter specifications manually.",
        )

    # Clean base64 string if data URL prefix was provided
    b64_data = request.image_base64
    if "," in b64_data:
        b64_data = b64_data.split(",", 1)[1]

    prompt_text = (
        "Analyze this photo. It is either an appliance rating label / energy efficiency guide, or a photo of the appliance itself (no label).\n"
        "Specifications (watts, voltage, kWh, EER, model) must come only from visibly printed text. Never invent missing specifications.\n"
        "The appliance TYPE, however, should always be identified from what the object looks like, even when nothing is printed.\n"
        "Return a valid JSON object with the following fields:\n"
        "- label_type: 'ELECTRICAL_SPECIFICATION' | 'ENERGY_EFFICIENCY' | 'MIXED' | 'UNKNOWN'\n"
        "- brand: string or null (brand name, only if printed or a clearly visible logo)\n"
        "- model: string or null (model number/code)\n"
        "- appliance_type: string or null. A common household name such as 'Electric fan', 'Ceiling fan', 'Air conditioner', 'Refrigerator', "
        "'Washing machine', 'Rice cooker', 'Electric kettle', 'Microwave', 'LED TV', 'Laptop', 'Clothes iron'. Identify it from the object even with no label.\n"
        "- identified_from: 'label' if the type/specs came from printed text, 'object' if recognized from the appliance's appearance\n"
        "- size_hint: string or null (visible size/variant that affects power, e.g. '16-inch stand fan', '55-inch TV', 'two-door refrigerator', 'window type aircon')\n"
        "- watts: number in watts (e.g. 65 for 65W, 500 for 0.5kW) or null. Must be electrical input wattage, NOT cooling capacity BTU/h and NOT motor horsepower HP.\n"
        "- voltage: string or null (e.g. '220V', '230V')\n"
        "- frequency: string or null (e.g. '60Hz')\n"
        "- current: string or null (e.g. '1.2A')\n"
        "- tested_kwh_month: number or null (tested monthly consumption in kWh/month if present on energy guide label)\n"
        "- tested_kwh_24h: number or null (tested daily consumption in kWh/24h if printed)\n"
        "- tested_kwh_year: number or null (tested annual consumption in kWh/year if printed)\n"
        "- energy_efficiency_rating: number or null (Energy Efficiency Rating / EER / Star rating e.g. 253 or 4.5. NEVER confuse EER with wattage or kWh)\n"
        "- raw_text: string (concise transcript of visible text on label)\n"
        "- evidence: string (quote the exact text showing ratings or state why wattage is missing)\n"
        "- confidence: 'high' | 'medium' | 'low'\n"
        "- notes: string or null (any relevant notes, e.g. 'Official Energy Guide label with tested monthly kWh and EER, no rated input wattage')"
    )

    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {
                        "inlineData": {
                            "mimeType": request.mime_type,
                            "data": b64_data,
                        }
                    },
                    {"text": prompt_text},
                ],
            }
        ],
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": 800,
            "responseMimeType": "application/json",
        },
    }

    model = os.getenv("GEMINI_MODEL", "gemini-3-flash-preview")
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(45.0, connect=10.0)) as client:
            response = await client.post(
                GEMINI_API_URL.format(model=model),
                headers={"x-goog-api-key": api_key},
                json=payload,
            )
    except httpx.TimeoutException as error:
        raise HTTPException(status_code=504, detail="The AI vision service timed out. Please try again.") from error
    except httpx.RequestError as error:
        raise HTTPException(status_code=502, detail="Could not reach the AI vision service. Please try again.") from error

    if response.is_error:
        raise HTTPException(status_code=502, detail="The AI vision service returned an error. Please try again later.")

    try:
        result = response.json()
    except ValueError as error:
        raise HTTPException(status_code=502, detail="The AI vision service returned an invalid response.") from error

    candidates = result.get("candidates") if isinstance(result, dict) else None
    if not isinstance(candidates, list) or not candidates or not isinstance(candidates[0], dict):
        raise HTTPException(status_code=502, detail="The AI vision service returned an empty reply.")

    content = candidates[0].get("content")
    parts = content.get("parts") if isinstance(content, dict) else None
    if not isinstance(parts, list):
        raise HTTPException(status_code=502, detail="The AI vision service returned an empty reply.")

    raw_json_str = next(
        (part.get("text") for part in parts if isinstance(part, dict) and isinstance(part.get("text"), str)),
        None,
    )
    if not raw_json_str or not raw_json_str.strip():
        raise HTTPException(status_code=502, detail="The AI vision service returned an empty reply.")

    # Parse JSON output from model
    try:
        data = json.loads(raw_json_str.strip())
    except json.JSONDecodeError:
        # Attempt to strip markdown code blocks if present
        clean_str = re.sub(r"^```(?:json)?\s*", "", raw_json_str.strip(), flags=re.MULTILINE)
        clean_str = re.sub(r"\s*```$", "", clean_str, flags=re.MULTILINE)
        try:
            data = json.loads(clean_str.strip())
        except json.JSONDecodeError as error:
            raise HTTPException(status_code=502, detail="The AI vision response could not be parsed as structured data.") from error

    if not isinstance(data, dict):
        raise HTTPException(status_code=502, detail="The AI vision service did not return an object.")

    # Deterministic validation of extracted values
    raw_watts = data.get("watts")
    validated_watts: float | None = None
    if isinstance(raw_watts, (int, float)) and 1 <= raw_watts <= 20000:
        validated_watts = float(raw_watts)

    raw_tested_kwh = data.get("tested_kwh_month")
    validated_kwh: float | None = None
    if isinstance(raw_tested_kwh, (int, float)) and 0 < raw_tested_kwh < 5000:
        validated_kwh = float(raw_tested_kwh)

    raw_tested_24h = data.get("tested_kwh_24h")
    validated_24h: float | None = None
    if isinstance(raw_tested_24h, (int, float)) and 0 < raw_tested_24h < 200:
        validated_24h = float(raw_tested_24h)

    raw_tested_year = data.get("tested_kwh_year")
    validated_year: float | None = None
    if isinstance(raw_tested_year, (int, float)) and 0 < raw_tested_year < 60000:
        validated_year = float(raw_tested_year)

    raw_eer = data.get("energy_efficiency_rating")
    validated_eer: float | None = None
    if isinstance(raw_eer, (int, float)) and 0 < raw_eer < 2000:
        validated_eer = float(raw_eer)

    label_type = str(data.get("label_type", "UNKNOWN")).upper().strip()
    if label_type not in {"ELECTRICAL_SPECIFICATION", "ENERGY_EFFICIENCY", "MIXED"}:
        has_energy = validated_kwh is not None or validated_24h is not None or validated_year is not None or validated_eer is not None
        if validated_watts is not None and has_energy:
            label_type = "MIXED"
        elif has_energy:
            label_type = "ENERGY_EFFICIENCY"
        elif validated_watts is not None:
            label_type = "ELECTRICAL_SPECIFICATION"
        else:
            label_type = "UNKNOWN"

    confidence = str(data.get("confidence", "medium")).lower()
    if confidence not in {"high", "medium", "low"}:
        confidence = "medium"

    return ApplianceVisionResponse(
        brand=str(data["brand"]).strip() if data.get("brand") else None,
        model=str(data["model"]).strip() if data.get("model") else None,
        appliance_type=str(data["appliance_type"]).strip()[:60] if data.get("appliance_type") else None,
        identified_from="object" if str(data.get("identified_from", "")).lower() == "object" else ("label" if data.get("identified_from") else None),
        size_hint=str(data["size_hint"]).strip()[:60] if data.get("size_hint") else None,
        watts=validated_watts,
        voltage=str(data["voltage"]).strip() if data.get("voltage") else None,
        frequency=str(data["frequency"]).strip() if data.get("frequency") else None,
        current=str(data["current"]).strip() if data.get("current") else None,
        tested_kwh_month=validated_kwh,
        tested_kwh_24h=validated_24h,
        tested_kwh_year=validated_year,
        energy_efficiency_rating=validated_eer,
        label_type=label_type,
        raw_text=str(data["raw_text"]).strip() if data.get("raw_text") else None,
        evidence=str(data["evidence"]).strip() if data.get("evidence") else None,
        confidence=confidence,
        notes=str(data["notes"]).strip() if data.get("notes") else None,
    )


# Last route (must stay at the end of this file): the built web app (pages + static files, see security/site.py)
# and a plain 404 for unknown /api paths.
app.add_api_route("/{full_path:path}", site.serve, methods=["GET", "HEAD", "POST", "PUT", "PATCH"],
                  include_in_schema=False)
