/**
 * Firestore-backed repository.
 * - Firebase Anonymous Authentication gives every guest a private uid (no registration).
 * - Firestore persistent local cache (IndexedDB) keeps data available offline and syncs when online.
 * - Data lives under users/{uid}/{bills|appliances|plans}/{id}; firestore.rules restrict access to the owner.
 * - Anonymous accounts are tied to this browser. upgradeAccount() links a Google account so the same
 *   data can be reached from another device.
 */
import { initializeApp, type FirebaseOptions } from 'firebase/app'
import { GoogleAuthProvider, getAuth, linkWithPopup, onAuthStateChanged, signInAnonymously, type User } from 'firebase/auth'
import {
  collection, deleteDoc, doc, getDocs, initializeFirestore, onSnapshot, persistentLocalCache, persistentMultipleTabManager,
  setDoc, writeBatch, type Firestore,
} from 'firebase/firestore'
import type { CollectionMap, CollectionName } from '../types'
import { COLLECTIONS, type Repo, type SyncState } from './repo'

class FirestoreRepo implements Repo {
  readonly mode = 'firestore' as const
  private pending = new Map<CollectionName, boolean>()
  private syncListeners = new Set<(s: SyncState) => void>()
  private db: Firestore
  private user: User

  constructor(db: Firestore, user: User) {
    this.db = db
    this.user = user
  }

  get userId() {
    return this.user.uid
  }
  get isAnonymous() {
    return this.user.isAnonymous
  }

  private col(c: CollectionName) {
    return collection(this.db, 'users', this.user.uid, c)
  }

  private emitSync() {
    const s: SyncState = [...this.pending.values()].some(Boolean) ? 'pending' : 'synced'
    this.syncListeners.forEach((cb) => cb(s))
  }

  onSyncState(cb: (s: SyncState) => void) {
    this.syncListeners.add(cb)
    return () => this.syncListeners.delete(cb)
  }

  subscribe<C extends CollectionName>(c: C, cb: (items: CollectionMap[C][]) => void, onError: (e: Error) => void) {
    return onSnapshot(
      this.col(c),
      { includeMetadataChanges: true },
      (snap) => {
        this.pending.set(c, snap.metadata.hasPendingWrites)
        this.emitSync()
        cb(snap.docs.map((d) => d.data() as CollectionMap[C]))
      },
      onError,
    )
  }

  // Writes land in the local cache immediately (snapshot fires) and sync in the background.
  // We do not await the server acknowledgement because it never resolves while offline;
  // the sync indicator shows "pending" until it does.
  put<C extends CollectionName>(c: C, item: CollectionMap[C]): Promise<void> {
    const write = setDoc(doc(this.col(c), item.id), JSON.parse(JSON.stringify(item)))
    write.catch((e) => console.error('Firestore write failed', e?.code ?? e))
    return Promise.resolve()
  }

  remove(c: CollectionName, id: string): Promise<void> {
    deleteDoc(doc(this.col(c), id)).catch((e) => console.error('Firestore delete failed', e?.code ?? e))
    return Promise.resolve()
  }

  async clearAll(): Promise<void> {
    for (const c of COLLECTIONS) {
      const snap = await getDocs(this.col(c))
      const batch = writeBatch(this.db)
      snap.docs.forEach((d) => batch.delete(d.ref))
      batch.commit().catch((e) => console.error('Firestore clear failed', e?.code ?? e))
    }
  }

  async upgradeAccount(): Promise<void> {
    await linkWithPopup(this.user, new GoogleAuthProvider())
  }
}

export async function createFirestoreRepo(config: FirebaseOptions): Promise<Repo> {
  const app = initializeApp(config)
  const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) })
  const auth = getAuth(app)
  const user = await new Promise<User>((resolve, reject) => {
    const unsub = onAuthStateChanged(
      auth,
      (u) => {
        if (u) {
          unsub()
          resolve(u)
        } else signInAnonymously(auth).catch((e) => { unsub(); reject(e) })
      },
      reject,
    )
  })
  return new FirestoreRepo(db, user)
}
