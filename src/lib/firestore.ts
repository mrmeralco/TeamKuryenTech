import { addDoc, collection, onSnapshot, orderBy, query, serverTimestamp } from "firebase/firestore";
import type { User } from "firebase/auth";
import { firestore } from "./firebase";

export interface UsageRecord {
  id: string;
  kwh: number;
  recordedAt: string;
}

export async function saveUsageRecord(user: User, kwh: number): Promise<void> {
  if (!firestore) throw new Error("Firestore is not configured.");
  if (!Number.isFinite(kwh) || kwh <= 0) throw new RangeError("Usage must be greater than zero.");
  await addDoc(collection(firestore, "users", user.uid, "readings"), {
    kwh,
    createdAt: serverTimestamp(),
  });
}

export function watchUsageRecords(
  user: User,
  onRecords: (records: UsageRecord[]) => void,
  onError: (error: Error) => void,
): () => void {
  if (!firestore) throw new Error("Firestore is not configured.");
  const readings = query(collection(firestore, "users", user.uid, "readings"), orderBy("createdAt", "desc"));
  return onSnapshot(
    readings,
    (snapshot) => {
      onRecords(snapshot.docs.map((document) => {
        const data = document.data({ serverTimestamps: "estimate" });
        return {
          id: document.id,
          kwh: Number(data.kwh),
          recordedAt: data.createdAt?.toDate?.().toISOString() ?? new Date().toISOString(),
        };
      }));
    },
    onError,
  );
}
