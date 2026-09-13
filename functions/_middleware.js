/**
 * 根中间件 —— 内容去重（Content Dedup）
 *
 * ============================ 为什么放在这里 ============================
 * 这是本仓库为了去重功能**唯一新增**的文件，`functions/_middleware.js` 在上游并不存在，
 * 因此这个改动是纯增量的：合并上游时不会与任何文件冲突。
 *
 * 三种部署目标都会自动挂载它，无需改动任何上游文件：
 *   - Cloudflare Pages ：原生根中间件，先于 functions/upload/_middleware.js 执行
 *   - Cloudflare Workers：deploy/worker/generate-routes.js 扫描时生成 mw_root，
 *                        由 getMiddlewareChain() 置于链首（改完需重新执行生成脚本）
 *   - Docker/Node       ：deploy/server/index.js 的 findMiddlewares() 显式优先检查根中间件
 *
 * ============================ 行为 ============================
 * 同一个文件（SHA-256 逐字节相同）无论从哪个渠道、哪个目录上传，都直接返回首次上传的链接，
 * 不再重复写入存储。第二次上传不会产生任何新记录、不会占用新存储。
 *
 * ============================ 有意不覆盖的范围 ============================
 * 分片上传（`chunked` / `initChunked`）不做去重，直接放行。原因：
 * initializeChunkedUpload() 从客户端只拿到 fileName/fileType/totalChunks，没有内容哈希，
 * 而 buildUniqueFileId() 是在所有分片传完、开始合并时才调用的 —— 服务端在数据已经落地之后
 * 才可能知道内容是什么，此时去重已经没有意义。要覆盖它必须改前端在上传前提供哈希，
 * 而前端源码在另一个仓库（MarSeventh/Sanyue-ImgHub）。
 *
 * ============================ 失效与竞争 ============================
 * - 删除/改名导致映射失效：命中时会校验目标是否仍存在，失效则清掉映射按未命中处理（自愈）。
 * - 并发上传同一份新内容：存在极小的竞争窗口（两次请求都判定未命中），会各自上传一次。
 *   本方案不引入分布式锁来消除它，代价与收益不成比例。
 */

import { getDatabase, checkDatabaseConfig } from './utils/databaseAdapter.js';
import { userAuthCheck } from './utils/auth/userAuth.js';
import { createResponse, getUploadIp, isBlockedUploadIp } from './upload/uploadTools.js';
import { fetchPageConfig } from './utils/sysConfig.js';
import {
    resolveDedupConfig,
    computeContentHash,
    findExistingFileId,
} from './utils/dedup/contentDedup.js';

/** 命中时附带的响应头，便于排查（不改动响应体，前端无感知） */
const DEDUP_HIT_HEADER = 'X-Dedup';

/**
 * 用已解析的 FormData 重建请求
 *
 * 请求体在中间件里已经被读过一次，必须交还一个可读的请求给业务代码，否则上游会拿到一个
 * 已消费的 body。用 `new Request(原请求, {...})` 构造可以保留 url / cf / signal 等属性，
 * 只替换 body。
 *
 * @param {Object} context
 * @param {FormData} formdata
 * @returns {boolean} 是否重建成功
 */
function rebuildRequest(context, formdata) {
    const original = context.request;
    const headers = new Headers(original.headers);

    // body 由 FormData 重新编码，旧的 content-length 与含 boundary 的 content-type 都不再适用
    headers.delete('content-length');
    headers.delete('content-type');

    try {
        context.request = new Request(original, {
            method: 'POST',
            headers,
            body: formdata,
        });
        return true;
    } catch (error) {
        console.error('[dedup] Failed to rebuild request:', error);
        return false;
    }
}

/**
 * 放行到业务处理，同时交还可读的请求体
 *
 * @param {Object} context
 * @param {FormData} formdata
 * @returns {Promise<Response>}
 */
function passThrough(context, formdata) {
    if (!rebuildRequest(context, formdata)) {
        // 体已消费却无法重建 → 明确报错，而不是把坏请求丢给上游产生难以定位的失败
        return createResponse('Error: content dedup failed to restore request body', { status: 500 });
    }
    return context.next();
}

/**
 * 构造命中去重时的响应
 *
 * 响应体格式与上传成功时完全一致（`[{ src, publicUrl? }]`），前端无需改动；
 * 是否命中去重通过 `X-Dedup` 响应头暴露。
 *
 * @param {Object} env
 * @param {URL} url
 * @param {string} fileId - 既有文件 id
 * @returns {Promise<Response>}
 */
async function buildDedupResponse(env, url, fileId) {
    const returnFormat = url.searchParams.get('returnFormat') || 'default';
    const returnLink = returnFormat === 'full'
        ? `${url.origin}/file/${fileId}`
        : `/file/${fileId}`;

    const result = { src: returnLink };

    // 与上传成功时一致：配置了 urlPrefix 才附带 publicUrl
    try {
        const pageConfig = await fetchPageConfig(env);
        const urlPrefix = pageConfig?.config?.find(item => item.id === 'urlPrefix')?.value || '';
        if (urlPrefix) {
            result.publicUrl = `${urlPrefix.replace(/\/+$/, '')}/${fileId}`;
        }
    } catch {
        // 读取页面配置失败不影响返回链接
    }

    return createResponse(JSON.stringify([result]), {
        headers: {
            'Content-Type': 'application/json',
            [DEDUP_HIT_HEADER]: 'hit',
        },
    });
}

/**
 * 根中间件入口
 */
export async function onRequest(context) {
    const { request, env } = context;

    // ---------- 以下判断都不会触碰请求体，可以安全地直接 next() ----------

    const url = new URL(request.url);
    if (url.pathname !== '/upload' && url.pathname !== '/upload/') {
        return context.next();
    }
    if (request.method !== 'POST') {
        return context.next();
    }

    // 只处理标准表单上传；其它 content-type 一律不介入，避免误消费请求体
    const contentType = (request.headers.get('content-type') || '').toLowerCase();
    if (!contentType.startsWith('multipart/form-data')) {
        return context.next();
    }

    // 分片上传与清理请求不适用去重（见文件头说明）
    if (url.searchParams.get('chunked') === 'true' ||
        url.searchParams.get('initChunked') === 'true' ||
        url.searchParams.get('cleanup') === 'true') {
        return context.next();
    }

    // 数据库未配置时交给上层中间件返回既有的错误响应
    if (!checkDatabaseConfig(env).configured) {
        return context.next();
    }

    let db;
    let config;
    try {
        db = getDatabase(env);
        config = await resolveDedupConfig(env, db);
    } catch (error) {
        console.error('[dedup] Config resolution failed, skip dedup:', error);
        return context.next();
    }
    if (!config.enabled) {
        return context.next();
    }

    // 体积预筛 + 尺寸可信度检查
    //
    // 必须有可用的 Content-Length 才继续往下走：multipart 表单上传（浏览器、curl -F）都会带它。
    // 若缺失（例如 chunked transfer-encoding），我们在解析之前无从判断体积，
    // 此时直接放行且**不消费请求体**，避免把未知大小的 body 整个读进内存。
    const declaredLength = Number(request.headers.get('content-length') || 0);
    if (!Number.isFinite(declaredLength) || declaredLength <= 0) {
        return context.next();
    }
    if (declaredLength > config.maxBytes + 64 * 1024) {
        return context.next();
    }

    // 鉴权必须在命中判断之前：否则未授权请求能靠"是否命中去重"探测某份内容是否已存在
    if (!await userAuthCheck(env, url, request, 'upload')) {
        return context.next();
    }

    const uploadIp = getUploadIp(request);
    if (await isBlockedUploadIp(env, uploadIp)) {
        return context.next();
    }

    // ---------- 从这里开始会消费请求体 ----------

    let formdata;
    try {
        formdata = await request.formData();
    } catch (error) {
        // 解析失败时体可能已部分消费，交还一个可读请求更稳妥
        console.error('[dedup] Failed to parse form data, skip dedup:', error);
        return context.next();
    }

    const file = formdata.get('file');
    // 非文件字段 / 空文件 → 跳过去重，交给上游按原有逻辑处理
    if (!file || typeof file === 'string' || typeof file.size !== 'number' || file.size === 0) {
        return passThrough(context, formdata);
    }

    // 超过上限的文件跳过去重（见配置 DEDUP_MAX_MB）
    if (file.size > config.maxBytes) {
        return passThrough(context, formdata);
    }

    let hash;
    try {
        hash = await computeContentHash(file);
    } catch (error) {
        console.error('[dedup] Failed to hash content, skip dedup:', error);
        return passThrough(context, formdata);
    }

    // 命中：直接返回既有链接，不写任何存储
    try {
        const existingFileId = await findExistingFileId(db, hash);
        if (existingFileId) {
            return await buildDedupResponse(env, url, existingFileId);
        }
    } catch (error) {
        console.error('[dedup] Lookup failed, continue as new upload:', error);
    }

    // 未命中：把哈希交给业务代码，由 uploadTools.endUpload() 在上传成功后落库
    //
    // 注意：必须走 context.data 而不是 context.dedupHash。
    // Cloudflare Pages 运行时（pages-template-worker.ts）会为链上**每个** handler
    // 新建一个 context 对象，只有 context.data 是跨环节共享的闭包变量；
    // 直接挂在 context 上的自定义字段传到下一个 handler 时就丢了。
    context.data.dedupHash = hash;
    context.data.dedupMeta = { size: file.size, name: file.name };

    return passThrough(context, formdata);
}
