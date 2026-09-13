/**
 * 内容去重（Content Dedup）
 *
 * 目的：同一份内容（按 SHA-256 逐字节判定）只保留一份存储，重复上传直接返回首次的链接。
 *
 * 存储设计
 * --------
 * hash → fileId 的映射写在 `content_hash_<sha256>` 键上，刻意**不加 `manage@` 前缀**：
 *   - 不加前缀 → 不会被 `api/manage/batch/settings.js` 的 `prefix: 'manage@'` 全量设置导出扫到
 *     （该接口会对每个键单独 `db.get`，若把映射放在 `manage@` 下会把备份功能拖垮）
 *   - 与项目既有的 `chunk_` / `upload_session_` 键风格一致
 *   - 列表接口取不到它：`readIndex` 只读分块索引；`getAllFileRecords` 会跳过没有
 *     `metadata.TimeStamp` 的记录，而这类键不写 metadata
 *
 * 因此**不需要修改 init.sql、不需要新增数据库表、不需要迁移**，KV / D1 / SQLite 三端行为一致。
 *
 * 删除与改名
 * ----------
 * 本项目把目录编码进文件 id，且删除即物理删除（`db.delete(fileId)`）、改名会换 id，
 * 所以映射会失效。这里不改造上游的删除/改名逻辑，而是在**命中时校验目标是否仍存在**：
 * 目标已消失就顺手清掉失效映射并按未命中处理。即删除/改名的失效是**自愈**的。
 */

/** 映射键前缀（刻意不带 manage@ 前缀，见文件头说明） */
const DEDUP_KEY_PREFIX = 'content_hash_';

/** 运行期配置键（可被环境变量覆盖） */
const CONFIG_KEY = 'manage@dedup@config';

/** 默认上限：32MB。计算哈希需要把文件读进内存，Workers 内存上限 128MB */
export const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/** 配置缓存，避免每次上传都读库 */
let cachedConfig = null;
let cachedConfigAt = 0;
const CONFIG_CACHE_TTL = 60 * 1000;

/**
 * 解析布尔值
 * @param {*} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function toBool(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false;
    if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true;
    return fallback;
}

/**
 * 解析正数（MB）
 * @param {*} value
 * @param {number} fallbackMB
 * @returns {number} 字节数
 */
function toMaxBytes(value, fallbackMB) {
    if (value === undefined || value === null || value === '') {
        return fallbackMB * 1024 * 1024;
    }
    const mb = Number(value);
    if (!Number.isFinite(mb) || mb <= 0) {
        return fallbackMB * 1024 * 1024;
    }
    return Math.round(mb * 1024 * 1024);
}

/**
 * 读取去重配置
 *
 * 优先级：环境变量 > 数据库设置项 > 默认值
 *   DEDUP_ENABLED    'false' 可整体关闭
 *   DEDUP_MAX_MB     覆盖 32MB 上限
 *
 * @param {Object} env - 环境变量
 * @param {Object} db - 数据库实例
 * @param {Object} [options]
 * @param {boolean} [options.force] - 跳过缓存强制重读（管理接口用）
 * @returns {Promise<{enabled: boolean, maxBytes: number, source: string}>}
 */
export async function resolveDedupConfig(env, db, options = {}) {
    const now = Date.now();
    if (!options.force && cachedConfig && now - cachedConfigAt < CONFIG_CACHE_TTL) {
        return cachedConfig;
    }

    let enabled = true;
    let maxBytes = DEFAULT_MAX_BYTES;
    let source = 'default';

    // 数据库设置项
    try {
        const raw = await db.get(CONFIG_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                if (parsed.enabled !== undefined) enabled = toBool(parsed.enabled, enabled);
                if (parsed.maxMB !== undefined) maxBytes = toMaxBytes(parsed.maxMB, 32);
                source = 'settings';
            }
        }
    } catch {
        // 设置项损坏不应影响上传，按默认值继续
    }

    // 环境变量优先
    if (env && env.DEDUP_ENABLED !== undefined) {
        enabled = toBool(env.DEDUP_ENABLED, enabled);
        source = 'env';
    }
    if (env && env.DEDUP_MAX_MB !== undefined) {
        maxBytes = toMaxBytes(env.DEDUP_MAX_MB, 32);
        source = 'env';
    }

    cachedConfig = { enabled, maxBytes, source };
    cachedConfigAt = now;
    return cachedConfig;
}

/**
 * 计算内容的 SHA-256（十六进制小写）
 * @param {Blob|File} file
 * @returns {Promise<string>}
 */
export async function computeContentHash(file) {
    const buffer = await file.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * 由哈希得到存储键
 * @param {string} hash
 * @returns {string}
 */
export function dedupKey(hash) {
    return DEDUP_KEY_PREFIX + hash;
}

/**
 * 查找哈希对应的既有文件 id
 *
 * 命中后会校验目标文件是否仍然存在；不存在则删除失效映射并返回 null（自愈删除/改名）。
 *
 * @param {Object} db - 数据库实例
 * @param {string} hash - 内容哈希
 * @returns {Promise<string|null>} 既有文件 id，未命中返回 null
 */
export async function findExistingFileId(db, hash) {
    if (!hash) return null;

    let raw;
    try {
        raw = await db.get(dedupKey(hash));
    } catch (error) {
        // 读映射本身失败（区别于"没命中"）——两者行为一致，但必须在日志上可区分，
        // 否则瞬时数据库错误会被静默当成未命中，去重悄悄失效且无从排查
        console.warn('[dedup] Failed to read mapping, treat as miss:', error?.message || error);
        return null;
    }
    if (!raw) return null;

    let fileId = null;
    try {
        const parsed = JSON.parse(raw);
        fileId = parsed && typeof parsed === 'object' ? parsed.fileId : null;
    } catch {
        // 兼容纯字符串值
        fileId = typeof raw === 'string' ? raw : null;
    }
    if (!fileId) return null;

    // 校验目标是否仍存在（删除即物理删除，改名会换 id）
    try {
        const record = await db.get(fileId);
        if (record === null || record === undefined) {
            await forgetContentHash(db, hash);
            return null;
        }
    } catch (error) {
        // 校验失败时保守处理：按未命中处理，不返回可能失效的链接
        console.warn('[dedup] Failed to verify target, treat as miss:', error?.message || error);
        return null;
    }

    return fileId;
}

/**
 * 记录 hash → fileId 映射
 *
 * @param {Object} db - 数据库实例
 * @param {string} hash - 内容哈希
 * @param {string} fileId - 文件 id
 * @param {Object} [extra] - 附加信息（仅用于排查，不参与判定）
 * @returns {Promise<boolean>}
 */
export async function recordContentHash(db, hash, fileId, extra = {}) {
    if (!hash || !fileId) return false;
    try {
        await db.put(dedupKey(hash), JSON.stringify({
            fileId,
            size: extra.size ?? null,
            name: extra.name ?? null,
            channel: extra.channel ?? null,
            at: Date.now(),
        }));
        return true;
    } catch (error) {
        // 落库失败意味着这份内容将来不会被复用；不影响本次上传，但要能排查到
        console.warn('[dedup] Failed to record mapping:', error?.message || error);
        return false;
    }
}

/**
 * 删除映射
 * @param {Object} db - 数据库实例
 * @param {string} hash - 内容哈希
 * @returns {Promise<boolean>}
 */
export async function forgetContentHash(db, hash) {
    try {
        await db.delete(dedupKey(hash));
        return true;
    } catch {
        return false;
    }
}

/**
 * 读取全部映射（管理接口用，分页遍历，带安全上限）
 *
 * @param {Object} db - 数据库实例
 * @param {Object} [options]
 * @param {number} [options.maxEntries] - 最多遍历多少条，防止大库拖死请求
 * @returns {Promise<{entries: Array, truncated: boolean}>}
 */
export async function listContentHashes(db, options = {}) {
    const maxEntries = options.maxEntries || 2000;
    const entries = [];
    let cursor = null;
    let truncated = false;

    try {
        while (true) {
            const listOptions = { prefix: DEDUP_KEY_PREFIX, limit: 1000 };
            if (cursor) listOptions.cursor = cursor;

            const result = await db.list(listOptions);
            const keys = (result && result.keys) || [];

            for (const item of keys) {
                if (entries.length >= maxEntries) {
                    truncated = true;
                    break;
                }
                const hash = item.name.slice(DEDUP_KEY_PREFIX.length);
                let value = null;
                try {
                    value = await db.get(item.name);
                } catch {
                    continue;
                }
                if (!value) continue;

                let parsed = null;
                try {
                    parsed = JSON.parse(value);
                } catch {
                    parsed = { fileId: value };
                }
                entries.push({ hash, ...parsed });
            }

            if (truncated) break;
            cursor = result && result.cursor;
            if (!cursor) break;
        }
    } catch (error) {
        return { entries, truncated, error: error.message };
    }

    return { entries, truncated };
}

/**
 * 清空所有映射（管理接口用）
 * 用于重建索引后重新积累，或排查问题
 *
 * @param {Object} db - 数据库实例
 * @param {Object} [options]
 * @param {number} [options.maxEntries] - 安全上限
 * @returns {Promise<{deleted: number, truncated: boolean}>}
 */
export async function clearContentHashes(db, options = {}) {
    const maxEntries = options.maxEntries || 10000;
    let deleted = 0;
    let cursor = null;
    let truncated = false;

    try {
        while (true) {
            const listOptions = { prefix: DEDUP_KEY_PREFIX, limit: 1000 };
            if (cursor) listOptions.cursor = cursor;

            const result = await db.list(listOptions);
            const keys = (result && result.keys) || [];
            if (keys.length === 0) break;

            for (const item of keys) {
                if (deleted >= maxEntries) {
                    truncated = true;
                    break;
                }
                try {
                    await db.delete(item.name);
                    deleted++;
                } catch {
                    // 单条失败不中断整体清理
                }
            }

            if (truncated) break;
            cursor = result && result.cursor;
            if (!cursor) break;
        }
    } catch (error) {
        return { deleted, truncated, error: error.message };
    }

    return { deleted, truncated };
}

/**
 * 使配置缓存失效（管理接口改完设置后调用）
 */
export function invalidateConfigCache() {
    cachedConfig = null;
    cachedConfigAt = 0;
}
