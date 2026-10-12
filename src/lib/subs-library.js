// ========== 本地字幕库（P3 2026-10-08）：IndexedDB 'vocabradar-subs' ==========
// 职责（方案 §3.1 生产体系）：扩展生产的字幕先落本地库，guide「字幕库」tab 审阅后
// 逐条上传分享。条目即事实源——删除本地只删本地，云端索引管理在网站「我的分享」。
// 上传成功后回填 shareState/cloudId/contentHash（shareState: local | shared）。
// 正文即纯文本（segments 拼接后入库），云端按规范化文本哈希去重（server/subs.js）。

const DB_NAME = 'vocabradar-subs'
const STORE = 'subs'
const DB_VERSION = 1

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx(store, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode)
        const req = fn(t.objectStore(STORE))  // fn 返回 IDBRequest（put/delete/get/getAll）
        t.oncomplete = () => { db.close(); resolve(req ? req.result : undefined) }
        t.onerror = () => { db.close(); reject(t.error) }
        t.onabort = () => { db.close(); reject(t.error || new Error('aborted')) }
      }),
  )
}

function makeId() {
  try { return crypto.randomUUID() } catch (e) {
    return 'sub-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
  }
}

// 组装条目：partial = {platform, videoId, lang, kind, title, durationSec, model, content, harvestedAt?}
// harvestedAt：SW 后台收割的完整字幕入 UNIQUE 库时间——未分享条目超 30 天由 SW 清扫
//   （用户令：完整字幕缓存周期同 30 天）；作者手动存入的条目无此字段，不参与清扫
export function makeEntry(partial) {
  return {
    id: makeId(),
    platform: String(partial.platform || 'local'),
    videoId: String(partial.videoId || ''),
    lang: String(partial.lang || 'en').split('-')[0].toLowerCase(),
    kind: ['asr', 'translation', 's2tt'].includes(partial.kind) ? partial.kind : 'asr',
    title: String(partial.title || '').slice(0, 200),
    durationSec: Number(partial.durationSec) > 0 ? Math.round(Number(partial.durationSec)) : 0,
    model: String(partial.model || ''),
    content: String(partial.content || ''),
    createdAt: Date.now(),
    harvestedAt: Number(partial.harvestedAt) > 0 ? Number(partial.harvestedAt) : null,
    shareState: 'local',
    cloudId: null,
    contentHash: null,
  }
}

export function saveSub(entry) {
  return tx(STORE, 'readwrite', (s) => s.put(entry))
}

export function getSub(id) {
  return tx(STORE, 'readonly', (s) => s.get(id))
}

export function deleteSub(id) {
  return tx(STORE, 'readwrite', (s) => s.delete(id))
}

export async function listSubs() {
  const all = await tx(STORE, 'readonly', (s) => s.getAll())
  const rows = (all && all.result) || all || []
  return rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
}

// 上传成功后回填云端状态
export function markShared(id, cloudId, contentHash) {
  return tx(STORE, 'readwrite', (s) => s.get(id)).then((r) => {
    const entry = (r && r.result) || r
    if (!entry) return null
    entry.shareState = 'shared'
    entry.cloudId = cloudId
    entry.contentHash = contentHash
    return tx(STORE, 'readwrite', (s) => s.put(entry))
  })
}
