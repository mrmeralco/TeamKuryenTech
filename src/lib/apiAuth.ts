import { signInAnonymously, type User } from "firebase/auth";
import { auth } from "./firebase";

let anonymousSignIn: Promise<User> | null = null;

/** Current Firebase user, creating a free anonymous personal session if needed. */
export async function ensureUser(): Promise<User> {
  const firebaseAuth = auth;
  if (!firebaseAuth) {
    throw new Error("Firebase is not configured.");
  }
  await firebaseAuth.authStateReady();
  return firebaseAuth.currentUser ?? await (anonymousSignIn ??= signInAnonymously(firebaseAuth)
    .then(({ user: guest }) => guest)
    .finally(() => {
      anonymousSignIn = null;
    }));
}

export async function getIdToken(): Promise<string> {
  return (await ensureUser()).getIdToken();
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await getIdToken();
  const response = await fetch(path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const error: { detail?: unknown } = await response.json();
      if (typeof error.detail === "string") message = error.detail;
      else if (Array.isArray(error.detail)) message = "Some fields are missing or invalid.";
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path);
}

export function apiPost<T>(path: string, body: unknown = {}): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function apiPutFile<T>(path: string, file: Blob): Promise<T> {
  return request<T>(path, {
    method: "PUT",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
}
