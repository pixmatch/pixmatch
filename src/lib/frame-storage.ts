const DB_NAME = "pixmatch-workspace";
const STORE = "images";

type StoredImage = { id: string; name: string; size: number; blob: Blob };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open image recovery storage."));
  });
}

export async function storeImages(images: StoredImage[]) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    images.forEach((image) => store.put(image));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not save uploaded images."));
  });
  db.close();
}

export async function restoreImages(): Promise<StoredImage[]> {
  const db = await openDb();
  const result = await new Promise<StoredImage[]>((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result as StoredImage[]);
    request.onerror = () => reject(request.error ?? new Error("Could not restore uploaded images."));
  });
  db.close();
  return result;
}

export async function removeStoredImage(id: string) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not remove stored image."));
  });
  db.close();
}
