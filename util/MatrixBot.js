/**
 * Matrix Bot 工具类
 * 用于通过 Matrix 协议发送消息和媒体
 */
import { MatrixClient, SimpleFsStorageProvider, AutojoinRoomsMixin } from 'matrix-bot-sdk';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

// Matrix 配置
const matrixConfig = {
    homeserver: process.env.MATRIX_HOMESERVER || 'https://matrix.org',
    userId: process.env.MATRIX_USER_ID || '',
    accessToken: process.env.MATRIX_ACCESS_TOKEN || '',
    roomId: process.env.MATRIX_ROOM_ID || '',
    // 媒体类型分流配置（可选）
    imageRoomId: process.env.MATRIX_IMAGE_ROOM_ID || '',       // 图片专用房间
    videoRoomId: process.env.MATRIX_VIDEO_ROOM_ID || '',       // 视频专用房间
    // 大文件配置（可选）
    largeFileRoomId: process.env.MATRIX_LARGE_FILE_ROOM_ID || '',
    largeFileThresholdMB: parseInt(process.env.MATRIX_LARGE_FILE_THRESHOLD_MB) || 0,  // 单位: MB, 0 表示不限制
    // 发送间隔（毫秒）
    sendIntervalMs: parseInt(process.env.MATRIX_SEND_INTERVAL_MS) || 1000,
    // 发送成功后是否自动删除本地文件
    autoDeleteOnSuccess: process.env.MATRIX_AUTO_DELETE_ON_SUCCESS === 'true'
};

let client = null;
// 记录上次发送时间
let lastSendTime = 0;

/**
 * 初始化 Matrix 客户端
 * @returns {Promise<MatrixClient>} 初始化的客户端
 */
export async function initMatrix() {
    if (!matrixConfig.userId || !matrixConfig.accessToken || !matrixConfig.roomId) {
        console.warn('Matrix 配置不完整，跳过初始化');
        return null;
    }

    try {
        // 使用 SimpleFsStorageProvider 存储客户端数据
        const storage = new SimpleFsStorageProvider(path.join(process.cwd(), '.matrix-storage.json'));

        // 创建客户端
        client = new MatrixClient(matrixConfig.homeserver, matrixConfig.accessToken, storage);

        // 自动加入被邀请的房间
        AutojoinRoomsMixin.setupOnClient(client);

        // 先设置消息监听器（在启动之前，确保不会错过启动过程中的消息）
        setupMessageListener();

        // 等待客户端启动
        await client.start();

        console.log(`Matrix 客户端已连接: ${matrixConfig.userId}`);
        console.log(`目标房间: ${matrixConfig.roomId}`);

        return client;
    } catch (error) {
        console.error('Matrix 客户端初始化失败:', error);
        throw error;
    }
}

/**
 * 获取 Matrix 客户端实例
 * @returns {MatrixClient|null}
 */
export function getMatrixClient() {
    return client;
}

/**
 * 检查 Matrix 是否已初始化
 * @returns {boolean}
 */
export function isMatrixInitialized() {
    return client !== null;
}

// 记录客户端启动时间，用于过滤历史消息
let clientStartTime = Date.now();

/**
 * 设置消息监听器
 */
function setupMessageListener() {
    if (!client) return;

    // 更新启动时间
    clientStartTime = Date.now();

    // 监听房间消息
    client.on('room.message', async (roomId, event) => {
        // 忽略启动之前的历史消息（事件时间戳早于客户端启动时间）
        const eventTimestamp = event.origin_server_ts;
        if (eventTimestamp && eventTimestamp < clientStartTime * 1000) {
            return;
        }
        console.log('收到消息:', event);
        
        // 忽略非文本消息
        if (event.content?.msgtype !== 'm.text') return;

        // 忽略自己发送的消息
        if (event.sender === matrixConfig.userId) return;

        const message = event.content?.body?.trim();

        // 处理 get-room-id 命令
        if (message === 'get-room-id') {
            try {
                const response = `当前房间 ID: ${roomId}`;
                await client.sendNotice(roomId, response);
                console.log(`已响应房间 ID 请求: ${roomId}`);
            } catch (error) {
                console.error('发送房间 ID 响应失败:', error);
            }
        }
    });

    console.log('Matrix 消息监听器已启动');
}

/**
 * 发送文本消息到指定房间
 * @param {string} roomId - 房间 ID
 * @param {string} message - 消息内容
 * @returns {Promise<string>} 事件 ID
 */
export async function sendMessage(roomId, message) {
    if (!client) {
        throw new Error('Matrix 客户端未初始化');
    }

    return await client.sendText(roomId, message);
}

/**
 * 发送媒体文件到指定房间
 * @param {string} roomId - 房间 ID
 * @param {Object} mediaInfo - 媒体信息对象
 * @param {string} mediaInfo.filePath - 媒体文件路径
 * @param {string} mediaInfo.thumbnailPath - 缩略图路径（可选）
 * @param {string} caption - 媒体说明文字（可选）
 * @returns {Promise<string>} 事件 ID
 */
export async function sendMedia(roomId, mediaInfo, caption = '') {
    if (!client) {
        throw new Error('Matrix 客户端未初始化');
    }

    if (!mediaInfo || !mediaInfo.filePath) {
        throw new Error('媒体信息无效');
    }

    // 检查文件是否存在
    if (!fs.existsSync(mediaInfo.filePath)) {
        throw new Error(`媒体文件不存在: ${mediaInfo.filePath}`);
    }

    // 发送间隔控制，避免过快被限流
    const now = Date.now();
    const elapsed = now - lastSendTime;
    if (elapsed < matrixConfig.sendIntervalMs) {
        const waitTime = matrixConfig.sendIntervalMs - elapsed;
        console.log(`发送间隔控制: 等待 ${waitTime}ms`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    lastSendTime = Date.now();

    try {
        // 根据文件扩展名判断 MIME 类型
        const mimeType = getMimeType(mediaInfo.filePath);
        const fileName = path.basename(mediaInfo.filePath);

        console.log(`正在发送媒体: ${fileName}, MIME: ${mimeType}`);

        // 准备内容信息
        const info = {
            mimetype: mimeType,
            size: mediaInfo.size || fs.statSync(mediaInfo.filePath).size
        };

        // 添加宽高等信息
        if (mediaInfo.width) info.w = mediaInfo.width;
        if (mediaInfo.height) info.h = mediaInfo.height;
        if (mediaInfo.duration) info.duration = Math.round(mediaInfo.duration);

        // 添加缩略图（如果有）- 缩略图较小，直接读取
        let thumbnailInfo = null;
        if (mediaInfo.thumbnailPath && fs.existsSync(mediaInfo.thumbnailPath)) {
            const thumbMimeType = getMimeType(mediaInfo.thumbnailPath);
            const thumbData = fs.readFileSync(mediaInfo.thumbnailPath);
            thumbnailInfo = {
                file: await client.uploadContent(thumbData, thumbMimeType, path.basename(mediaInfo.thumbnailPath)),
                mimetype: thumbMimeType,
                size: thumbData.length
            };
            if (mediaInfo.thumbnailWidth) thumbnailInfo.w = mediaInfo.thumbnailWidth;
            if (mediaInfo.thumbnailHeight) thumbnailInfo.h = mediaInfo.thumbnailHeight;
        }

        // 上传媒体内容到 Matrix
        console.log(`[上传] 开始上传: ${fileName} (${info.size} bytes)`);
        
        // 上传前验证文件存在且大小正常
        const uploadStats = fs.statSync(mediaInfo.filePath);
        console.log(`[上传] 文件实际大小: ${uploadStats.size} bytes`);
        
        if (uploadStats.size !== info.size) {
            console.warn(`[上传] 警告：缓存大小(${info.size})与实际大小(${uploadStats.size})不一致`);
        }
        
        // 使用 Buffer 上传（matrix-bot-sdk 的 uploadContent 对 Node.js stream 支持有问题）
        const mediaData = fs.readFileSync(mediaInfo.filePath);
        let mxcUrl;
        try {
            mxcUrl = await client.uploadContent(mediaData, mimeType, fileName);
        } catch (uploadError) {
            // 标记错误来源为上传
            uploadError._step = 'upload';
            throw uploadError;
        }
        // 立即释放 buffer 引用
        mediaData.fill(0);  
        console.log(`[上传] 上传完成，MXC URL: ${mxcUrl.substring(0, 30)}...`);

        // 构建消息内容
        const content = {
            msgtype: mimeType.startsWith('image/') ? 'm.image' : 'm.video',
            url: mxcUrl,
            info,
            body: fileName
        };

        // 如果有缩略图，添加到内容中
        if (thumbnailInfo) {
            content.info.thumbnail_url = thumbnailInfo.file;
            content.info.thumbnail_info = {
                mimetype: thumbnailInfo.mimetype,
                size: thumbnailInfo.size,
                w: thumbnailInfo.w,
                h: thumbnailInfo.h
            };
        }
        // console.log('content:', content);

        // 发送消息（核心操作，失败需要重试）
        let eventId;
        try {
            eventId = await client.sendMessage(roomId, content);
        } catch (sendError) {
            // 标记错误来源为发送消息
            sendError._step = 'sendMessage';
            throw sendError;
        }
        console.log(`媒体发送成功: ${eventId}`);

        // 如果是视频，发送视频时长和大小信息（辅助操作，失败不重试）
        if (content.msgtype === 'm.video') {
            const sizeInfo = formatFileSize(info.size);
            const durationInfo = info.duration ? `时长: ${formatDuration(info.duration)}` : '';
            const infoText = `📹 ${fileName}\n${durationInfo}${durationInfo && sizeInfo ? '大小: ' : ''}${sizeInfo}`;
            
            try {
                await client.sendNotice(roomId, infoText);
                console.log(`已发送视频信息: ${infoText}`);
            } catch (noticeErr) {
                // sendNotice 失败只记录警告，不触发重试，避免重复发送媒体
                if (noticeErr?.errcode === 'M_LIMIT_EXCEEDED' || noticeErr?.message?.includes('Too Many Requests')) {
                    const waitMs = noticeErr?.retryAfterMs || noticeErr?.retry_after_ms || 3000;
                    console.warn(`[sendNotice] 视频信息发送被限流，等待 ${(waitMs / 1000).toFixed(1)}s 后重试...`);
                    await new Promise(resolve => setTimeout(resolve, waitMs + 500));
                    try {
                        await client.sendNotice(roomId, infoText);
                        console.log(`[sendNotice] 视频信息重试成功`);
                    } catch (retryErr) {
                        console.warn(`[sendNotice] 视频信息发送最终失败（已忽略）:`, retryErr.message);
                    }
                } else {
                    console.warn(`[sendNotice] 视频信息发送失败（已忽略）:`, noticeErr.message);
                }
            }
        }

        // 发送成功后，自动删除本地文件和缩略图（如果启用）
        if (matrixConfig.autoDeleteOnSuccess) {
            await deleteLocalFiles(mediaInfo.filePath, mediaInfo.thumbnailPath);
        }

        return eventId;
    } catch (error) {
        // 检查是否为限流错误 (M_LIMIT_EXCEEDED)
        if (error?.errcode === 'M_LIMIT_EXCEEDED' || error?.message?.includes('Too Many Requests')) {
            const errorStep = error._step ? `(${error._step})` : '';
            
            // 优先使用服务器返回的重试时间
            let retryDelayMs = error?.retryAfterMs || error?.retry_after_ms;
            if (!retryDelayMs) {
                retryDelayMs = 3 * 60 * 1000; // 默认 3分钟
            }
            // 加上缓冲时间（多等 500ms 确保安全）
            retryDelayMs += 500;
            
            console.error(`[限流] Matrix API 限流 ${errorStep}，等待 ${(retryDelayMs / 1000).toFixed(1)} 秒后重试...`);
            
            await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            console.log('[限流] 重试发送...');
            
            try {
                return await sendMedia(roomId, mediaInfo, caption);
            } catch (retryError) {
                console.error('重试后仍然失败:', retryError);
                if (matrixConfig.autoDeleteOnSuccess) {
                    await deleteLocalFiles(mediaInfo.filePath, mediaInfo.thumbnailPath);
                }
                throw retryError;
            }
        }
        
        console.error('发送媒体失败:', error);
        if (matrixConfig.autoDeleteOnSuccess) {
            await deleteLocalFiles(mediaInfo.filePath, mediaInfo.thumbnailPath);
        }
        throw error;
    }
}

/**
 * 使用默认配置的 roomId 发送媒体
 * 根据媒体类型（图片/视频）自动选择对应房间，再根据文件大小判断是否发送到大文件房间
 * @param {Object} mediaInfo - 媒体信息对象
 * @param {string} caption - 媒体说明文字（可选）
 * @returns {Promise<string>} 事件 ID
 */
export async function sendMediaDefault(mediaInfo, caption = '') {
    if (!matrixConfig.roomId) {
        throw new Error('未配置 MATRIX_ROOM_ID');
    }

    // 获取文件大小（字节）
    let fileSize = mediaInfo.size || 0;
    if (!fileSize && mediaInfo.filePath && fs.existsSync(mediaInfo.filePath)) {
        fileSize = fs.statSync(mediaInfo.filePath).size;
    }

    // 1. 根据媒体类型选择分流房间
    let targetRoomId = matrixConfig.roomId;
    const mimeType = getMimeType(mediaInfo.filePath || '');
    
    if (mimeType.startsWith('image/') && matrixConfig.imageRoomId) {
        targetRoomId = matrixConfig.imageRoomId;
        console.log(`[分流] 图片 -> 图片专用房间: ${targetRoomId}`);
    } else if (mimeType.startsWith('video/') && matrixConfig.videoRoomId) {
        targetRoomId = matrixConfig.videoRoomId;
        console.log(`[分流] 视频 -> 视频专用房间: ${targetRoomId}`);
    }

    // 2. 判断是否需要发送到大文件房间（优先级高于类型分流）
    const thresholdMB = matrixConfig.largeFileThresholdMB;
    const thresholdBytes = thresholdMB * 1024 * 1024;

    if (thresholdMB > 0 && matrixConfig.largeFileRoomId && fileSize > thresholdBytes) {
        const oldRoom = targetRoomId;
        targetRoomId = matrixConfig.largeFileRoomId;
        const sizeStr = formatFileSize(fileSize);
        console.log(`[大文件] 文件大小 ${sizeStr} 超过阈值 ${thresholdMB}MB，发送到大文件房间: ${targetRoomId}`);
    }

    return await sendMedia(targetRoomId, mediaInfo, caption);
}

/**
 * 发送图片到指定房间
 * @param {string} roomId - 房间 ID
 * @param {string} imagePath - 图片路径
 * @param {string} caption - 图片说明（可选）
 * @returns {Promise<string>} 事件 ID
 */
export async function sendImage(roomId, imagePath, caption = '') {
    const mediaInfo = {
        filePath: imagePath,
        size: fs.statSync(imagePath).size
    };
    return await sendMedia(roomId, mediaInfo, caption);
}

/**
 * 发送视频到指定房间
 * @param {string} roomId - 房间 ID
 * @param {string} videoPath - 视频路径
 * @param {string} caption - 视频说明（可选）
 * @returns {Promise<string>} 事件 ID
 */
export async function sendVideo(roomId, videoPath, caption = '') {
    const mediaInfo = {
        filePath: videoPath,
        size: fs.statSync(videoPath).size
    };
    return await sendMedia(roomId, mediaInfo, caption);
}

/**
 * 根据文件扩展名获取 MIME 类型
 * @param {string} filePath - 文件路径
 * @returns {string} MIME 类型
 */
function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
        '.svg': 'image/svg+xml',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mov': 'video/quicktime',
        '.avi': 'video/x-msvideo',
        '.mkv': 'video/x-matroska'
    };
    return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * 格式化文件大小
 * @param {number} bytes - 文件大小（字节）
 * @returns {string} 格式化后的文件大小
 */
function formatFileSize(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }
    return `${size.toFixed(2)} ${units[unitIndex]}`;
}

/**
 * 格式化时长
 * @param {number} seconds - 时长（秒）
 * @returns {string} 格式化后的时长
 */
function formatDuration(seconds) {
    if (!seconds) return '';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${minutes}:${String(secs).padStart(2, '0')}`;
}

/**
 * 删除本地媒体文件和缩略图
 * @param {string} filePath - 媒体文件路径
 * @param {string} thumbnailPath - 缩略图路径（可选）
 */
async function deleteLocalFiles(filePath, thumbnailPath) {
    // 删除媒体文件
    if (filePath && fs.existsSync(filePath)) {
        try {
            fs.unlinkSync(filePath);
            console.log(`[清理] 已删除媒体文件: ${path.basename(filePath)}`);
        } catch (err) {
            console.error(`[清理] 删除媒体文件失败: ${filePath}`, err.message);
        }
    }

    // 删除缩略图
    if (thumbnailPath && fs.existsSync(thumbnailPath)) {
        try {
            fs.unlinkSync(thumbnailPath);
            console.log(`[清理] 已删除缩略图: ${path.basename(thumbnailPath)}`);
        } catch (err) {
            console.error(`[清理] 删除缩略图失败: ${thumbnailPath}`, err.message);
        }
    }
}

/**
 * 关闭 Matrix 客户端连接
 * @returns {Promise<void>}
 */
export async function closeMatrix() {
    if (client) {
        await client.stop();
        client = null;
        console.log('Matrix 客户端已关闭');
    }
}

export default {
    initMatrix,
    getMatrixClient,
    isMatrixInitialized,
    sendMessage,
    sendMedia,
    sendMediaDefault,
    sendImage,
    sendVideo,
    closeMatrix
};
