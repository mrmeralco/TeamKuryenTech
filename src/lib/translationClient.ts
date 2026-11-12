import { getIdToken } from "./apiAuth";

export type TranslationLanguage = {
  code: string;
  name: string;
};

async function postTranslationRequest<T>(path: string, body?: unknown): Promise<T> {
  const token = await getIdToken();
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (!response.ok) {
    let message = `Translation service failed (${response.status}).`;
    try {
      const error: { detail?: string } = await response.json();
      if (error.detail) message = error.detail;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    throw new Error(message);
  }

  return response.json() as Promise<T>;
}

export async function fetchSupportedLanguages(): Promise<TranslationLanguage[]> {
  const response = await postTranslationRequest<{ languages?: TranslationLanguage[] }>("/api/translate/languages");
  if (!Array.isArray(response.languages) || !response.languages.every(
    (language) => typeof language.code === "string" && typeof language.name === "string",
  )) {
    throw new Error("Translation service returned an invalid language list.");
  }
  return response.languages;
}

export async function translateTexts(target: string, texts: string[]): Promise<string[]> {
  if (!texts.length) return [];
  const response = await postTranslationRequest<{ translations?: string[] }>("/api/translate", { target, texts });
  if (!Array.isArray(response.translations) || response.translations.length !== texts.length ||
    !response.translations.every((translation) => typeof translation === "string")) {
    throw new Error("Translation service returned an invalid translation response.");
  }
  return response.translations;
}
