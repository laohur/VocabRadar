/**
 * Cross-platform storage for cached language dictionaries
 * - Browser: IndexedDB
 * - Node.js: filesystem (~/.diverse-lemmas/)
 */

const DB_NAME = 'diverse-lemmas';
const STORE_NAME = 'languages';
const DB_VERSION = 1;

// Detect environment
const isBrowser = typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
const isNode = !!(typeof process !== 'undefined' && process.versions?.node);

// ============================================
// Browser Storage (IndexedDB)
// ============================================

let dbPromise = null;

function getDB() {
  if (!isBrowser) return null;
  
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'lang' });
        }
      };
    });
  }
  
  return dbPromise;
}

async function browserGet(lang) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(lang);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result || null);
  });
}

async function browserSet(lang, data) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put({ lang, ...data, cachedAt: Date.now() });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

async function browserDelete(lang) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(lang);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

async function browserList() {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAllKeys();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function browserClear() {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.clear();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

// ============================================
// Node.js Storage (Filesystem)
// ============================================

let nodeFs = null;
let nodePath = null;
let nodeCacheDir = null;

async function getNodeModules() {
  if (!isNode) return null;
  
  if (!nodeFs) {
    nodeFs = await import('fs/promises');
    nodePath = await import('path');
    const os = await import('os');
    nodeCacheDir = nodePath.join(os.homedir(), '.diverse-lemmas', 'cache');
    
    // Ensure cache directory exists
    await nodeFs.mkdir(nodeCacheDir, { recursive: true }).catch(() => {});
  }
  
  return { fs: nodeFs, path: nodePath, cacheDir: nodeCacheDir };
}

async function nodeGet(lang) {
  const { fs, path, cacheDir } = await getNodeModules();
  const filePath = path.join(cacheDir, `${lang}.json`);
  
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function nodeSet(lang, data) {
  const { fs, path, cacheDir } = await getNodeModules();
  const filePath = path.join(cacheDir, `${lang}.json`);
  await fs.writeFile(filePath, JSON.stringify({ lang, ...data, cachedAt: Date.now() }));
}

async function nodeDelete(lang) {
  const { fs, path, cacheDir } = await getNodeModules();
  const filePath = path.join(cacheDir, `${lang}.json`);
  await fs.unlink(filePath).catch(() => {});
}

async function nodeList() {
  const { fs, cacheDir } = await getNodeModules();
  try {
    const files = await fs.readdir(cacheDir);
    return files.filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
  } catch {
    return [];
  }
}

async function nodeClear() {
  const { fs, cacheDir } = await getNodeModules();
  try {
    const files = await fs.readdir(cacheDir);
    await Promise.all(files.map(f => fs.unlink(`${cacheDir}/${f}`).catch(() => {})));
  } catch {}
}

// ============================================
// Unified Storage API
// ============================================

export const storage = {
  /**
   * Get cached language data
   * @param {string} lang - Language code
   * @returns {Promise<{wordDict: object, ambiguityMap?: object, cachedAt: number} | null>}
   */
  async get(lang) {
    if (isBrowser) return browserGet(lang);
    if (isNode) return nodeGet(lang);
    return null;
  },

  /**
   * Cache language data
   * @param {string} lang - Language code
   * @param {object} data - { wordDict, ambiguityMap? }
   */
  async set(lang, data) {
    if (isBrowser) return browserSet(lang, data);
    if (isNode) return nodeSet(lang, data);
  },

  /**
   * Delete cached language
   * @param {string} lang - Language code
   */
  async delete(lang) {
    if (isBrowser) return browserDelete(lang);
    if (isNode) return nodeDelete(lang);
  },

  /**
   * List all cached languages
   * @returns {Promise<string[]>}
   */
  async list() {
    if (isBrowser) return browserList();
    if (isNode) return nodeList();
    return [];
  },

  /**
   * Clear all cached languages
   */
  async clear() {
    if (isBrowser) return browserClear();
    if (isNode) return nodeClear();
  },

  /**
   * Check if running in browser
   */
  get isBrowser() { return isBrowser; },

  /**
   * Check if running in Node.js
   */
  get isNode() { return isNode; },
};

export default storage;

