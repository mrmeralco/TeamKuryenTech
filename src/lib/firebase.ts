import { getApp, getApps, initializeApp } from "firebase/app";
import { connectAuthEmulator, getAuth } from "firebase/auth";
import {
  connectFirestoreEmulator,
  initializeFirestore,
  getFirestore,
  memoryLocalCache,
  persistentLocalCache,
  persistentSingleTabManager,
  type Firestore,
} from "firebase/firestore";

// Local development/testing against the Firebase Emulator Suite uses a
// "demo-" project, which can never reach real Firebase resources.
export const usingEmulators = import.meta.env.VITE_USE_FIREBASE_EMULATORS === "true";

function emulatorPort(value: string | undefined, fallback: number, name: string): number {
  const port = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(`${name} must be a valid TCP port.`);
  }
  return port;
}

const emulatorHost = import.meta.env.VITE_FIREBASE_EMULATOR_HOST || "127.0.0.1";
const authEmulatorPort = emulatorPort(import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_PORT, 9099, "Auth emulator port");
const firestoreEmulatorPort = emulatorPort(import.meta.env.VITE_FIREBASE_FIRESTORE_EMULATOR_PORT, 8080, "Firestore emulator port");
if (usingEmulators && !["127.0.0.1", "localhost", "::1"].includes(emulatorHost)) {
  throw new Error("Firebase emulators must use a loopback host.");
}

const config = usingEmulators
  ? {
      apiKey: "demo-api-key",
      authDomain: "demo-smartwatts.firebaseapp.com",
      projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "demo-smartwatts",
      appId: "demo-app",
    }
  : {
      apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
      authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
      appId: import.meta.env.VITE_FIREBASE_APP_ID,
    };

export const firebaseConfigured = Object.values(config).every((value) => Boolean(value));
let firestore: Firestore | null = null;
let auth: ReturnType<typeof getAuth> | null = null;

if (firebaseConfigured) {
  const existingApp = getApps().length > 0;
  const app = existingApp ? getApp() : initializeApp(config);
  auth = getAuth(app);
  firestore = existingApp
    ? getFirestore(app)
    : initializeFirestore(app, {
        localCache: usingEmulators
          ? memoryLocalCache()
          : persistentLocalCache({ tabManager: persistentSingleTabManager(undefined) }),
      });
  if (usingEmulators && !existingApp) {
    connectAuthEmulator(auth, `http://${emulatorHost.includes(":") ? `[${emulatorHost}]` : emulatorHost}:${authEmulatorPort}`, { disableWarnings: true });
    connectFirestoreEmulator(firestore, emulatorHost, firestoreEmulatorPort);
  }
}

export { auth, firestore };
