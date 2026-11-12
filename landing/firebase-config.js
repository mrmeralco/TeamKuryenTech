// Public Firebase web config (identifies the project; not a secret).
// Security is enforced by Firebase Auth + firestore.rules, not by hiding this.
export const firebaseConfig = {
  apiKey: "AIzaSyCzchB2LWT3wL0sdHtxcV3FL_i7kqz434M",
  authDomain: "smartwatts-266cc.firebaseapp.com",
  projectId: "smartwatts-266cc",
  storageBucket: "smartwatts-266cc.firebasestorage.app",
  messagingSenderId: "662254708202",
  appId: "1:662254708202:web:a4eb9d9ea2427fae0b3e93",
  measurementId: "G-KCMMNFC4CS",
};

// Where users go after a successful login / verified registration.
export const DASHBOARD_URL = "/dashboard";
