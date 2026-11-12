import os
from typing import Annotated, Literal

import firebase_admin
import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from firebase_admin import auth as firebase_auth
from firebase_admin.exceptions import FirebaseError
from google.auth.exceptions import DefaultCredentialsError
from pydantic import BaseModel, ConfigDict, Field, model_validator

load_dotenv()

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

    @model_validator(mode="after")
    def require_latest_user_message(self):
        if self.messages[-1].role != "user":
            raise ValueError("The latest chat message must be from the user.")
        return self


class ChatReply(BaseModel):
    reply: str


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


app = FastAPI(title="SmartWatts API", version="2.0.0")
allowed_origins = [
    origin.strip()
    for origin in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Authorization"],
)

def require_guest(authorization: Annotated[str | None, Header()] = None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="A Firebase guest sign-in is required.")

    project_id = os.getenv("FIREBASE_PROJECT_ID", "").strip()
    if not project_id:
        raise HTTPException(status_code=503, detail="Firebase authentication is not configured on the server.")

    try:
        try:
            firebase_app = firebase_admin.get_app()
        except ValueError:
            firebase_app = firebase_admin.initialize_app(options={"projectId": project_id})
        claims = firebase_auth.verify_id_token(authorization.removeprefix("Bearer ").strip(), app=firebase_app)
    except (firebase_auth.InvalidIdTokenError, firebase_auth.ExpiredIdTokenError):
        raise HTTPException(status_code=401, detail="The Firebase sign-in token is invalid or expired.")
    except (DefaultCredentialsError, FirebaseError) as error:
        raise HTTPException(status_code=503, detail="Firebase token verification is unavailable.") from error

    if claims.get("firebase", {}).get("sign_in_provider") != "anonymous":
        raise HTTPException(status_code=403, detail="An anonymous Firebase account is required.")
    return claims["uid"]


@app.get("/api/health")
async def health():
    return {"status": "ok"}


async def google_translation_request(method: str, *, params: dict[str, str], payload: dict | None = None):
    api_key = os.getenv("GOOGLE_TRANSLATE_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(status_code=503, detail="Google Cloud Translation is not configured on the server.")

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=5.0)) as client:
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
async def translation_languages(_guest_uid: str = Depends(require_guest)):
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
async def translate(request: TranslationRequest, _guest_uid: str = Depends(require_guest)):
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
async def chat(request: ChatRequest, _guest_uid: str = Depends(require_guest)):
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
    payload = {
        "systemInstruction": {
            "parts": [{
                "text": (
                    "You are the SmartWatts energy-saving assistant. Be helpful, concise, and practical. "
                    f"Reply only in the language identified by language code '{request.language}'. "
                    "Do not claim access to the user's account "
                    "or live electricity data."
                )
            }]
        },
        "contents": contents,
        "generationConfig": {"temperature": 0.7, "maxOutputTokens": 700},
    }

    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
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
    return ChatReply(reply=reply.strip())
