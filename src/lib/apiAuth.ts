import { signInAnonymously, type User } from "firebase/auth";
import { auth } from "./firebase";

let anonymousSignIn: Promise<User> | null = null;

export async function getGuestIdToken(): Promise<string> {
  const firebaseAuth = auth;
  if (!firebaseAuth) {
    throw new Error("Firebase is not configured for guest access.");
  }

  const user = firebaseAuth.currentUser ?? await (anonymousSignIn ??= signInAnonymously(firebaseAuth)
    .then(({ user: guest }) => guest)
    .finally(() => {
      anonymousSignIn = null;
    }));

  return user.getIdToken();
}
