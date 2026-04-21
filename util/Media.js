/**
 * 媒体处理工具类
 * 用于下载视频/图片，并通过 ffmpeg 获取媒体信息、生成缩略图
 * 支持保存媒体信息到 MongoDB 并检测重复
 */
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { request, ProxyAgent } from 'undici';

dotenv.config();

const execAsync = promisify(exec);

/**
 * 配置对象
 */
let mediaConfig = {
    downloadDir: process.env.MEDIA_DOWNLOAD_DIR || './downloads',
    thumbnailDir: process.env.MEDIA_THUMBNAIL_DIR || './thumbnails',
    thumbnailWidth: process.env.MEDIA_THUMBNAIL_WIDTH || 720,
    proxy: process.env.PROXY_URI || null,
    // 低内存模式配置（默认开启）
    lowMemoryMode: process.env.MEDIA_LOW_MEMORY_MODE !== 'false',  // 默认启用
    maxConcurrentDownloads: parseInt(process.env.MEDIA_MAX_CONCURRENT_DOWNLOADS) || 1,  // 并发下载数限制
    // 文件大小限制（字节），超过此大小的文件直接丢弃，默认 1GB
    maxFileSizeBytes: (parseFloat(process.env.MEDIA_MAX_FILE_SIZE_GB) || 1) * 1024 * 1024 * 1024
};

// 下载并发控制信号量
let downloadSemaphore = null;

function getDownloadSemaphore() {
    if (!downloadSemaphore) {
        downloadSemaphore = createSemaphore(mediaConfig.maxConcurrentDownloads);
    }
    return downloadSemaphore;
}

/**
 * 简单的信号量实现，用于控制并发数
 */
function createSemaphore(maxConcurrency) {
    let current = 0;
    const queue = [];
    
    return function acquire() {
        return new Promise(resolve => {
            if (current < maxConcurrency) {
                current++;
                resolve(release);
            } else {
                queue.push(resolve);
            }
        });
        
        function release() {
            current--;
            if (queue.length > 0 && current < maxConcurrency) {
                current++;
                const next = queue.shift();
                next(release);
            }
        }
    };
}

/**
 * MongoDB 集合引用
 */
let mediaCollection = null;

/**
 * 设置媒体信息集合
 * @param {Object} collection - MongoDB 集合对象
 */
export function setMediaCollection(collection) {
    mediaCollection = collection;
}

/**
 * 初始化 Media 配置
 * 可以在应用启动时调用以配置自定义路径
 *
 * @param {Object} options - 配置选项
 * @param {string} options.downloadDir - 下载目录
 * @param {string} options.thumbnailDir - 缩略图目录
 * @param {number} options.thumbnailWidth - 缩略图宽度
 * @param {string} options.proxy - 代理地址
 */
export async function initMedia(options = {}) {
    mediaConfig = {
        ...mediaConfig,
        ...options
    };

    // 确保目录存在
    if (mediaConfig.downloadDir && !fs.existsSync(mediaConfig.downloadDir)) {
        fs.mkdirSync(mediaConfig.downloadDir, { recursive: true });
    }
    if (mediaConfig.thumbnailDir && !fs.existsSync(mediaConfig.thumbnailDir)) {
        fs.mkdirSync(mediaConfig.thumbnailDir, { recursive: true });
    }

    console.log('Media initialized with config:', mediaConfig);
}

/**
 * 获取当前 Media 配置
 *
 * @returns {Object} 当前配置对象
 */
export function getMediaConfig() {
    return { ...mediaConfig };
}

/**
 * 流式计算文件哈希值（避免大文件整文件载入内存）
 * @param {string} filePath - 文件路径
 * @returns {Promise<string>} SHA256 哈希值
 */
function calculateFileHashStream(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

/**
 * 从 Content-Type 获取文件扩展名
 * @param {string} contentType - Content-Type 头
 * @returns {string} 文件扩展名（带点）
 */
function getExtensionFromContentType(contentType) {
    const mimeToExt = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'image/bmp': '.bmp',
        'image/svg+xml': '.svg',
        'video/mp4': '.mp4',
        'video/webm': '.webm',
        'video/quicktime': '.mov',
        'video/x-msvideo': '.avi',
        'video/x-matroska': '.mkv'
    };

    if (!contentType) return null;

    const mimeType = contentType.split(';')[0].trim().toLowerCase();
    return mimeToExt[mimeType] || null;
}

/**
 * 通过 URL 下载视频或图片（流式写入磁盘，避免大文件爆内存）
 *
 * @param {string} url - 资源 URL
 * @param {string} type - 媒体类型: 'image' 或 'video'
 * @returns {Promise<string>} 下载后的文件路径
 */
export async function downloadMedia(url, type = null) {
    // 低内存模式下限制并发
    const semaphore = getDownloadSemaphore();
    const release = await semaphore;
    
    try {
        // 使用 undici 的请求选项
        const dispatcher = mediaConfig.proxy
            ? new ProxyAgent(mediaConfig.proxy)
            : undefined;

        console.log(`正在下载: ${url}`);
        if (mediaConfig.proxy) {
            console.log(`使用代理: ${mediaConfig.proxy}`);
        }

        // 使用 undici 请求
        const response = await request(url, {
            dispatcher,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        // 检查响应状态
        if (response.statusCode !== 200) {
            throw new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`);
        }

        // 检查文件大小限制（通过 Content-Length 预检）
        const contentLength = parseInt(response.headers['content-length']) || 0;
        const maxBytes = mediaConfig.maxFileSizeBytes;
        if (contentLength > maxBytes) {
            // 中止响应，不读取 body（需要先监听 error 事件避免 uncaughtException）
            response.body.on('error', () => {});  // 忽略 abort 导致的错误
            response.body.destroy();
            throw new Error(`文件过大: ${(contentLength / 1024 / 1024 / 1024).toFixed(2)}GB > ${maxBytes / 1024 / 1024 / 1024}GB 限制，已丢弃`);
        }
        console.log(`Content-Length: ${contentLength ? (contentLength / 1024 / 1024).toFixed(1) + 'MB' : '未知'} (上限: ${(maxBytes / 1024 / 1024 / 1024).toFixed(1)}GB)`);

        // 从 Content-Type 获取扩展名
        let ext = getExtensionFromContentType(response.headers['content-type']);

        // 如果没有获取到扩展名，尝试从 URL 中提取
        if (!ext) {
            const urlParts = url.split('/');
            const filename = urlParts[urlParts.length - 1].split('?')[0];
            ext = path.extname(filename);
        }

        // 如果仍然没有扩展名，根据类型使用默认值
        if (!ext) {
            if (type === '视频') {
                ext = '.mp4';
            } else if (type === '图片') {
                ext = '.jpg';
            } else {
                ext = '.bin';
                console.warn('无法确定文件扩展名，使用默认值: .bin');
            }
        }

        // 确保扩展名以点开头
        if (ext && !ext.startsWith('.')) {
            ext = '.' + ext;
        }

        // 使用时间戳生成文件名
        const timestamp = Date.now();
        const filename = `${timestamp}${ext}`;

        // 构建完整输出路径
        const outputPath = path.join(mediaConfig.downloadDir, filename);
        const dir = path.dirname(outputPath);

        // 确保目录存在
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // 流式写入文件，避免整个文件进入内存
        await new Promise((resolve, reject) => {
            const writeStream = fs.createWriteStream(outputPath);
            
            writeStream.on('finish', () => {
                console.log(`[流式] 文件写入完成`);
                resolve();
            });
            writeStream.on('error', (err) => {
                console.error(`[流式] 写入失败:`, err);
                reject(err);
            });
            
            // undici 的 response.body (BodyReadable) 本身就是 Node.js Stream，可直接 pipe
            response.body.pipe(writeStream);
            
            response.body.on('error', (err) => {
                console.error(`[流式] 读取响应失败:`, err);
                writeStream.destroy(err);
                reject(err);
            });
        });

        // 检查文件大小并验证下载完整性
        const stats = fs.statSync(outputPath);
        console.log(`文件大小: ${stats.size} 字节 (${(stats.size / 1024).toFixed(1)} KB)`);
        
        if (stats.size === 0) {
            fs.unlinkSync(outputPath);
            throw new Error('下载的文件内容为空');
        }
        
        // 二次检查：下载完成后再次验证文件大小限制（Content-Length 可能不准确）
        if (stats.size > maxBytes) {
            fs.unlinkSync(outputPath);
            throw new Error(`下载后文件过大: ${(stats.size / 1024 / 1024 / 1024).toFixed(2)}GB > ${maxBytes / 1024 / 1024 / 1024}GB，已删除`);
        }
        
        // 检查是否为异常小的文件（可能是 HTTP 错误页面）
        const MIN_FILE_SIZE = type === '视频' ? 10000 : 2000;  // 视频 >10KB, 图片 >2KB
        if (stats.size < MIN_FILE_SIZE) {
            // 读取前 500 字节判断是否为 HTML/JSON 错误响应
            const fd = fs.openSync(outputPath, 'r');
            const headBuf = Buffer.alloc(Math.min(stats.size, 500));
            fs.readSync(fd, headBuf, 0, headBuf.length, 0);
            fs.closeSync(fd);
            const headStr = headBuf.toString('utf-8');
            
            if (headStr.startsWith('<') || headStr.startsWith('{')) {
                fs.unlinkSync(outputPath);
                throw new Error(`下载内容异常（${stats.size}字节），可能是HTTP错误响应: ${headStr.substring(0, 100)}`);
            }
        }

        console.log(`下载完成: ${outputPath}`);
        return outputPath;
    } catch (error) {
        console.error('下载媒体失败:', error);
        throw error;
    } finally {
        // 释放信号量
        release();
    }
}

/**
 * 保存媒体信息到数据库
 *
 * @param {Object} mediaInfo - 媒体信息对象
 */
async function saveMediaInfo(mediaInfo) {
    if (!mediaCollection) {
        console.warn('媒体集合未设置，跳过保存到数据库');
        return;
    }

    try {
        const document = {
            url: mediaInfo.url || null,
            filePath: mediaInfo.filePath,
            width: mediaInfo.width,
            height: mediaInfo.height,
            duration: mediaInfo.duration,
            size: mediaInfo.size,
            hasAudio: mediaInfo.hasAudio,
            codec: mediaInfo.codec,
            format: mediaInfo.format,
            hash: mediaInfo.hash,
            thumbnailPath: mediaInfo.thumbnailPath || null,
            thumbnailWidth: mediaInfo.thumbnailWidth || null,
            thumbnailHeight: mediaInfo.thumbnailHeight || null,
            createdAt: new Date()
        };

        await mediaCollection.insertOne(document);
        console.log(`媒体信息已保存到数据库: ${mediaInfo.hash.substring(0, 8)}...`);
    } catch (error) {
        console.error('保存媒体信息到数据库失败:', error);
        throw error;
    }
}

/**
 * 检查媒体是否已存在（通过哈希和文件大小）
 *
 * @param {string} hash - 文件哈希值
 * @param {number} size - 文件大小
 * @returns {Promise<boolean>} 是否存在
 */
async function checkMediaExists(hash, size) {
    if (!mediaCollection) {
        return false;
    }

    try {
        const existing = await mediaCollection.findOne({ hash, size });
        return !!existing;
    } catch (error) {
        console.error('检查媒体是否存在失败:', error);
        return false;
    }
}

/**
 * 使用 FFmpeg 获取媒体信息并生成缩略图
 *
 * @param {string} inputPath - 输入文件路径
 * @returns {Promise<Object>} 媒体信息对象
 */
export async function getMediaInfo(inputPath) {
    try {
        // 1. 使用 ffprobe 获取媒体信息
        const probeCommand = `ffprobe -v quiet -print_format json -show_format -show_streams "${inputPath}"`;
        const { stdout: probeOutput } = await execAsync(probeCommand);
        const probeData = JSON.parse(probeOutput);

        // 2. 提取视频流信息
        const videoStream = probeData.streams.find(stream => stream.codec_type === 'video');
        const audioStream = probeData.streams.find(stream => stream.codec_type === 'audio');

        // 3. 获取基本信息
        const stats = fs.statSync(inputPath);
        const fileSize = stats.size;

        const width = videoStream ? videoStream.width : null;
        const height = videoStream ? videoStream.height : null;
        const duration = probeData.format ? parseFloat(probeData.format.duration) : 0;

        // 4. 流式计算文件哈希值（避免大文件整文件载入内存）
        const hash = await calculateFileHashStream(inputPath);

        // 5. 检查是否重复
        const isDuplicate = await checkMediaExists(hash, fileSize);
        if (isDuplicate) {
            // 删除原文件和缩略图
            try {
                fs.unlinkSync(inputPath);
                console.log(`已删除重复文件: ${inputPath}`);
            } catch (err) {
                console.error(`删除文件失败: ${inputPath}`, err);
            }

            // 抛出重复错误
            const error = new Error('Duplicate media detected');
            error.code = 'DUPLICATE_MEDIA';
            error.hash = hash;
            error.size = fileSize;
            throw error;
        }

        // 6. 构建媒体信息对象
        const mediaInfo = {
            filePath: inputPath,
            width,
            height,
            duration,
            size: fileSize,
            hasAudio: !!audioStream,
            codec: videoStream ? videoStream.codec_name : null,
            format: probeData.format ? probeData.format.format_name : null,
            hash
        };

        // console.log('媒体信息:', mediaInfo);

        // 7. 生成缩略图（720 宽，保持长宽比）
        if (width && height) {
            // 计算缩略图尺寸
            const thumbnailWidth = mediaConfig.thumbnailWidth;
            const thumbnailHeight = Math.round((height / width) * thumbnailWidth);

            // 生成缩略图文件名（使用时间戳）
            const basename = path.basename(inputPath, path.extname(inputPath));
            const thumbnailFilename = `${basename}_thumb.jpg`;

            // 构建缩略图输出路径
            const thumbnailPath = path.join(mediaConfig.thumbnailDir, thumbnailFilename);
            const thumbnailDir = path.dirname(thumbnailPath);

            // 确保缩略图目录存在
            if (!fs.existsSync(thumbnailDir)) {
                fs.mkdirSync(thumbnailDir, { recursive: true });
            }

            // 检查是否为图片文件且原图尺寸小于缩略图尺寸
            if (duration <= 0 && width <= thumbnailWidth && height <= thumbnailHeight) {
                // 直接复制原图作为缩略图
                const imageBuffer = fs.readFileSync(inputPath);
                fs.writeFileSync(thumbnailPath, imageBuffer);
                console.log(`图片尺寸小于缩略图尺寸，直接使用原图作为缩略图: ${thumbnailPath} (原图尺寸: ${width}x${height})`);
                
                // 缩略图尺寸使用原图尺寸
                mediaInfo.thumbnailPath = thumbnailPath;
                mediaInfo.thumbnailWidth = width;
                mediaInfo.thumbnailHeight = height;
            } else {
                // 生成缩略图的 ffmpeg 命令
                let ffmpegCommand;
                if (duration > 0) {
                    // 视频文件：在第 1 秒截取缩略图
                    ffmpegCommand = `ffmpeg -y -i "${inputPath}" -ss 00:00:01 -vframes 1 -vf "scale=${thumbnailWidth}:${thumbnailHeight}" "${thumbnailPath}"`;
                } else {
                    // 图片文件：直接缩放
                    ffmpegCommand = `ffmpeg -y -i "${inputPath}" -vf "scale=${thumbnailWidth}:${thumbnailHeight}" "${thumbnailPath}"`;
                }

                // 执行 ffmpeg 命令
                await execAsync(ffmpegCommand);
                console.log(`缩略图已生成: ${thumbnailPath} (尺寸: ${thumbnailWidth}x${thumbnailHeight})`);

                // 添加缩略图信息到返回对象
                mediaInfo.thumbnailPath = thumbnailPath;
                mediaInfo.thumbnailWidth = thumbnailWidth;
                mediaInfo.thumbnailHeight = thumbnailHeight;
            }
        }

        // 8. 保存媒体信息到数据库
        await saveMediaInfo(mediaInfo);

        return mediaInfo;
    } catch (error) {
        // 如果是重复错误，直接抛出
        if (error.code === 'DUPLICATE_MEDIA') {
            throw error;
        }
        console.error('获取媒体信息失败:', error);
        throw error;
    }
}

/**
 * 完整流程：下载媒体并获取信息及缩略图
 *
 * @param {string} url - 媒体 URL
 * @param {string} type - 媒体类型: 'image' 或 'video'
 * @returns {Promise<Object>} 媒体信息对象
 */
export async function processMedia(url, type = null) {
    try {
        // 1. 下载媒体（使用时间戳命名，扩展名从响应头获取）
        const downloadedPath = await downloadMedia(url, type);

        // 2. 获取媒体信息并生成缩略图
        const mediaInfo = await getMediaInfo(downloadedPath);
        mediaInfo.url = url;

        return mediaInfo;
    } catch (error) {
        // 如果是重复错误，直接抛出
        if (error.code === 'DUPLICATE_MEDIA') {
            throw error;
        }
        console.error('处理媒体失败:', error);
        throw error;
    }
}

export default {
    initMedia,
    setMediaCollection,
    getMediaConfig,
    downloadMedia,
    getMediaInfo,
    processMedia
};
