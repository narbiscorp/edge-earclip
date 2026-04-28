import { openDB, type IDBPDatabase } from 'idb';

export const DB_NAME = 'narbis-dashboard';
export const DB_VERSION = 2;

export const STORE_PRESETS = 'presets';
export const STORE_RECORDING_SESSIONS = 'recording_sessions';
export const STORE_RECORDING_CHUNKS = 'recording_chunks';
export const STORE_RECORDING_BLOBS = 'recording_blobs';

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
      },
    });
  }
  return dbPromise;
}
