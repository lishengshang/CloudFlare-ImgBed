/**
 * 内容去重管理接口
 *
 * GET    读取当前配置与统计
 * POST   更新配置（写入 manage@dedup@config）
 * DELETE 清空全部 hash → fileId 映射
 *
 * 鉴权由 functions/api/manage/_middleware.js 统一处理（需要管理员身份或 manage 权限的 API Token），
 * 本文件无需自行判定权限。
 */

import { getDatabase } from '../../utils/databaseAdapter.js';
import {
    resolveDedupConfig,
    listContentHashes,
    clearContentHashes,
    invalidateConfigCache,
    DEFAULT_MAX_BYTES,
} from '../../utils/dedup/contentDedup.js';

const CONFIG_KEY = 'manage@dedup@config';

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'private, no-store, max-age=0',
        },
    });
}

/** 最小可配置上限：1KB。低于此值没有实际意义，且四舍五入回显时会退化成 0 */
const MIN_MAX_MB = 0.001;

/**
 * 字节转 MB
 * 不能用 Math.round，否则 0.001MB 这类小值会回显成 0，与实际生效值不符
 * @param {number} bytes
 * @returns {number}
 */
function bytesToMB(bytes) {
    return Number((bytes / 1024 / 1024).toFixed(4));
}

/**
 * 统计映射数量（带安全上限，避免大库拖死请求）
 * @param {Object} db
 * @returns {Promise<Object>}
 */
async function collectStats(db) {
    const { entries, truncated, error } = await listContentHashes(db, { maxEntries: 2000 });
    if (error) {
        return { error };
    }

    const byChannel = {};
    let totalBytes = 0;
    for (const entry of entries) {
        const channel = entry.channel || 'Unknown';
        byChannel[channel] = (byChannel[channel] || 0) + 1;
        if (Number.isFinite(entry.size)) totalBytes += entry.size;
    }

    return {
        mappedCount: entries.length,
        truncated,
        totalSizeMB: Number((totalBytes / 1024 / 1024).toFixed(2)),
        byChannel,
        recent: entries
            .slice()
            .sort((a, b) => (b.at || 0) - (a.at || 0))
            .slice(0, 10)
            .map(entry => ({
                hash: entry.hash,
                fileId: entry.fileId,
                name: entry.name,
                size: entry.size,
                channel: entry.channel,
                at: entry.at,
            })),
    };
}

export async function onRequest(context) {
    const { request, env } = context;
    const db = getDatabase(env);

    if (request.method === 'GET') {
        const config = await resolveDedupConfig(env, db, { force: true });
        return jsonResponse({
            config: {
                enabled: config.enabled,
                maxMB: bytesToMB(config.maxBytes),
                source: config.source,
                defaultMaxMB: bytesToMB(DEFAULT_MAX_BYTES),
            },
            // 环境变量优先级高于设置项，明确标出来避免误判
            envOverride: {
                DEDUP_ENABLED: env.DEDUP_ENABLED ?? null,
                DEDUP_MAX_MB: env.DEDUP_MAX_MB ?? null,
            },
            stats: await collectStats(db),
        });
    }

    if (request.method === 'POST') {
        let body;
        try {
            body = await request.json();
        } catch {
            return jsonResponse({ success: false, error: 'Invalid JSON body' }, 400);
        }

        const current = await resolveDedupConfig(env, db, { force: true });
        const next = {
            enabled: body.enabled === undefined ? current.enabled : !!body.enabled,
            maxMB: body.maxMB === undefined
                ? bytesToMB(current.maxBytes)
                : Number(body.maxMB),
        };

        if (!Number.isFinite(next.maxMB) || next.maxMB < MIN_MAX_MB) {
            return jsonResponse({
                success: false,
                error: `maxMB must be a number >= ${MIN_MAX_MB}`,
            }, 400);
        }

        await db.put(CONFIG_KEY, JSON.stringify(next));
        invalidateConfigCache();

        const resolved = await resolveDedupConfig(env, db, { force: true });
        return jsonResponse({
            success: true,
            config: {
                enabled: resolved.enabled,
                maxMB: bytesToMB(resolved.maxBytes),
                source: resolved.source,
            },
            note: resolved.source === 'env'
                ? 'Environment variables DEDUP_ENABLED / DEDUP_MAX_MB take precedence over this setting.'
                : undefined,
        });
    }

    if (request.method === 'DELETE') {
        const result = await clearContentHashes(db, { maxEntries: 10000 });
        return jsonResponse({ success: true, ...result });
    }

    return jsonResponse({ success: false, error: 'Method Not Allowed' }, 405);
}
