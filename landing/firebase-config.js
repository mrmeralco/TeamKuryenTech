// Public Firebase web config (identifies the project; not a secret).
// Emulator config is selected only by Vite's explicit local test flag.
const useEmulators = import.meta.env.VITE_USE_FIREBASE_EMULATORS === "true";
const emulatorHost = import.meta.env.VITE_FIREBASE_EMULATOR_HOST || "127.0.0.1";
const authEmulatorPort = import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_PORT || "9099";

export const firebaseConfig = useEmulators
  ? {
      apiKey: "demo-api-key",
      authDomain: "demo-smartwatts.firebaseapp.com",
      projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "demo-smartwatts",
      appId: "demo-app",
    }
  : {
      apiKey: "AIzaSyCzchB2LWT3wL0sdHtxcV3FL_i7kqz434M",
      authDomain: "smartwatts-266cc.firebaseapp.com",
      projectId: "smartwatts-266cc",
      storageBucket: "smartwatts-266cc.firebasestorage.app",
      messagingSenderId: "662254708202",
      appId: "1:662254708202:web:a4eb9d9ea2427fae0b3e93",
      measurementId: "G-KCMMNFC4CS",
    };

export const authEmulatorUrl = useEmulators
  ? `http://${emulatorHost.includes(":") ? `[${emulatorHost}]` : emulatorHost}:${authEmulatorPort}`
  : null;

// Where users go after a successful login / verified registration.
export const DASHBOARD_URL = "/dashboard";
