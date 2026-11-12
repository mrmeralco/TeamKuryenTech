import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import {
  initializeFirestore,
  getFirestore,
  persistentLocalCache,
  persistentSingleTabManager,
  type Firestore,
} from "firebase/firestore";

const config = {
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
        localCache: persistentLocalCache({ tabManager: persistentSingleTabManager(undefined) }),
      });
}

export { auth, firestore };
