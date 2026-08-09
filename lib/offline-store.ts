import type { NonInventoryRecord, PricingSettings, ProductRecord } from "./pricing";

const DB_NAME = "nutriplus-offline-v1";
const DB_VERSION = 1;
const SNAPSHOT_KEY = "app-snapshot";

export type OfflineSnapshot = {
  settings: PricingSettings;
  products: ProductRecord[];
  quotes: NonInventoryRecord[];
  savedAt: string;
};

export type QueuedMutation = {
  id: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  tempId?: number;
  createdAt: string;
};

function openOfflineDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      if (!db.objectStoreNames.contains("mutations")) db.createObjectStore("mutations", { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("No se pudo abrir el almacenamiento sin conexión."));
  });
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("No se pudo completar la operación local."));
  });
}

export async function saveOfflineSnapshot(snapshot: OfflineSnapshot) {
  const db = await openOfflineDb();
  try {
    const transaction = db.transaction("meta", "readwrite");
    await requestResult(transaction.objectStore("meta").put(snapshot, SNAPSHOT_KEY));
  } finally { db.close(); }
}

export async function loadOfflineSnapshot() {
  const db = await openOfflineDb();
  try {
    const transaction = db.transaction("meta", "readonly");
    return (await requestResult(transaction.objectStore("meta").get(SNAPSHOT_KEY))) as OfflineSnapshot | undefined;
  } finally { db.close(); }
}

export async function enqueueMutation(mutation: QueuedMutation) {
  const db = await openOfflineDb();
  try {
    const transaction = db.transaction("mutations", "readwrite");
    await requestResult(transaction.objectStore("mutations").put(mutation));
  } finally { db.close(); }
}

export async function listQueuedMutations() {
  const db = await openOfflineDb();
  try {
    const transaction = db.transaction("mutations", "readonly");
    const items = await requestResult(transaction.objectStore("mutations").getAll()) as QueuedMutation[];
    return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } finally { db.close(); }
}

export async function removeQueuedMutation(id: string) {
  const db = await openOfflineDb();
  try {
    const transaction = db.transaction("mutations", "readwrite");
    await requestResult(transaction.objectStore("mutations").delete(id));
  } finally { db.close(); }
}
