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
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectFirestoreEmulator(firestore, "127.0.0.1", 8080);
  }
}

export { auth, firestore };
