import { openDB, type IDBPDatabase } from 'idb';

export const DB_NAME = 'narbis-dashboard';
export const DB_VERSION = 4;

export const STORE_PRESETS = 'presets';
/** Coherence Engine tunable presets (full CoherenceTunables snapshots). Separate from
 * STORE_PRESETS, which holds firmware NarbisRuntimeConfig presets. */
export const STORE_COHERENCE_PRESETS = 'coherence_presets';
export const STORE_RECORDING_SESSIONS = 'recording_sessions';
export const STORE_RECORDING_CHUNKS = 'recording_chunks';
export const STORE_RECORDING_BLOBS = 'recording_blobs';
/**
 * Sessions that failed to save to Supabase (offline / network error) are
 * buffered here keyed by the client-generated session id. The
 * `pendingSyncQueue` module flushes this store on the next online + auth
 * event by upserting each row to Supabase.
 */
export const STORE_PENDING_SYNC_SESSIONS = 'pending_sync_sessions';

let dbPromise: Promise<IDBPDatabase> | null = null;

export function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore(STORE_PRESETS, { keyPath: 'id' });
        }
        if (oldVersion < 2) {
          if (!db.objectStoreNames.contains(STORE_RECORDING_SESSIONS)) {
            db.createObjectStore(STORE_RECORDING_SESSIONS, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(STORE_RECORDING_CHUNKS)) {
            const chunks = db.createObjectStore(STORE_RECORDING_CHUNKS, {
              keyPath: ['sessionId', 'chunkSeq'],
            });
            chunks.createIndex('by_session', 'sessionId', { unique: false });
          }
          if (!db.objectStoreNames.contains(STORE_RECORDING_BLOBS)) {
            db.createObjectStore(STORE_RECORDING_BLOBS, { keyPath: 'id' });
          }
        }
        if (oldVersion < 3) {
          if (!db.objectStoreNames.contains(STORE_PENDING_SYNC_SESSIONS)) {
            db.createObjectStore(STORE_PENDING_SYNC_SESSIONS, { keyPath: 'id' });
          }
        }
        if (oldVersion < 4) {
          if (!db.objectStoreNames.contains(STORE_COHERENCE_PRESETS)) {
            db.createObjectStore(STORE_COHERENCE_PRESETS, { keyPath: 'id' });
          }
        }
      },
    });
  }
  return dbPromise;
}
