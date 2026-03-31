/**
 * GetMyX - 定时获取 Twitter/X 媒体并下载
 */

import { initRsshub, getMedia, initMongo } from './util/Rsshub.js';
import { initMedia, processMedia, setMediaCollection } from './util/Media.js';
import { initMatrix, sendMediaDefault, isMatrixInitialized, closeMatrix } from './util/MatrixBot.js';
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';

dotenv.config();

// 配置参数
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '*/30 * * * *'; // 默认每30分钟执行一次
const MEDIA_COLLECTION_NAME = process.env.MEDIA_COLLECTION_NAME || 'media';

// 状态追踪
let isRunning = false;
let mongoClient = null;
let db = null;
let mediaCollection = null;

/**
 * 初始化应用
 */
async function initialize() {
    try {
        console.log('正在初始化...');

        // 1. 初始化 MongoDB
        await initMongo();

        // 获取 Mongo 连接
        const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
        const dbName = process.env.MONGODB_DATABASE || 'getmyx';
        
        mongoClient = new MongoClient(uri);
        await mongoClient.connect();
        db = mongoClient.db(dbName);
        mediaCollection = db.collection(MEDIA_COLLECTION_NAME);
        
        // 设置 Media 模块的集合
        setMediaCollection(mediaCollection);
        
        // 创建唯一索引
        await mediaCollection.createIndex({ hash: 1, size: 1 }, { unique: true });
        console.log('MongoDB 连接成功');

        // 2. 初始化 Rsshub
        await initRsshub();
        console.log('Rsshub 初始化成功');

        // 3. 初始化 Media 模块
        await initMedia({
            downloadDir: process.env.MEDIA_DOWNLOAD_DIR || './downloads',
            thumbnailDir: process.env.MEDIA_THUMBNAIL_DIR || './thumbnails',
            thumbnailWidth: parseInt(process.env.MEDIA_THUMBNAIL_WIDTH) || 720,
            proxy: process.env.PROXY_URI || null
        });
        console.log('Media 模块初始化成功');

        // 4. 初始化 Matrix Bot（如果配置了）
        await initMatrix();
        if (isMatrixInitialized()) {
            console.log('Matrix Bot 初始化成功');
        }

        console.log('初始化完成\n');
    } catch (error) {
        console.error('初始化失败:', error);
        throw error;
    }
}

/**
 * 处理单个媒体项
 */
async function processMediaItem(url, type) {
    try {
        const mediaInfo = await processMedia(url, type);
        console.log(`  ✓ ${type}下载成功: ${mediaInfo.filePath} (${(mediaInfo.size / 1024 / 1024).toFixed(2)} MB)`);

        // 通过 Matrix 发送媒体
        if (isMatrixInitialized()) {
            try {
                const caption = `${type}: ${url.substring(0, 80)}...`;
                await sendMediaDefault(mediaInfo, caption);
                console.log(`  ✓ ${type}已发送到 Matrix`);
            } catch (matrixError) {
                console.error(`  ✗ ${type}发送 Matrix 失败: ${matrixError.message}`);
            }
        }

        return true;
    } catch (error) {
        if (error.code === 'DUPLICATE_MEDIA') {
            console.log(`  ⊗ ${type}已存在，跳过: ${url.substring(0, 50)}...`);
        } else {
            console.error(`  ✗ ${type}处理失败: ${error.message}`);
        }
        return false;
    }
}

/**
 * 主任务函数
 */
async function mainTask() {
    if (isRunning) {
        console.log('\n任务正在运行中，跳过本次执行');
        return;
    }

    isRunning = true;
    console.log('\n========== 开始执行任务 ==========');
    console.log(`执行时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);

    try {
        // 1. 从 Rsshub 获取媒体链接
        console.log('\n正在从 Rsshub 获取媒体...');
        const media = await getMedia();

        if (!media || (media.img.length === 0 && media.video.length === 0)) {
            console.log('没有发现新的媒体内容');
            return;
        }

        console.log(`发现 ${media.img.length} 张图片, ${media.video.length} 个视频`);

        // 2. 下载图片
        let imgSuccess = 0;
        if (media.img.length > 0) {
            console.log('\n开始下载图片...');
            for (const url of media.img) {
                const success = await processMediaItem(url, '图片');
                if (success) imgSuccess++;
            }
            console.log(`图片下载完成: ${imgSuccess}/${media.img.length}`);
        }

        // 3. 下载视频
        let videoSuccess = 0;
        if (media.video.length > 0) {
            console.log('\n开始下载视频...');
            for (const url of media.video) {
                const success = await processMediaItem(url, '视频');
                if (success) videoSuccess++;
            }
            console.log(`视频下载完成: ${videoSuccess}/${media.video.length}`);
        }

        const total = media.img.length + media.video.length;
        const successCount = imgSuccess + videoSuccess;
        console.log(`\n总进度: ${successCount}/${total} 成功`);

    } catch (error) {
        console.error('\n任务执行失败:', error);
    } finally {
        isRunning = false;
        console.log('========== 任务执行完成 ==========\n');
    }
}

/**
 * 清理24小时之前的文件
 */
async function cleanupOldFiles() {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24小时
    const dirs = [
        process.env.MEDIA_DOWNLOAD_DIR || './downloads',
        process.env.MEDIA_THUMBNAIL_DIR || './thumbnails'
    ];

    let totalDeleted = 0;

    for (const dir of dirs) {
        try {
            if (!fs.existsSync(dir)) continue;

            const files = fs.readdirSync(dir);
            for (const file of files) {
                const filePath = path.join(dir, file);
                try {
                    const stats = fs.statSync(filePath);
                    if (stats.isFile() && (now - stats.mtimeMs) > maxAge) {
                        fs.unlinkSync(filePath);
                        totalDeleted++;
                        console.log(`  已删除: ${file}`);
                    }
                } catch (err) {
                    console.error(`  删除失败: ${file}, 错误: ${err.message}`);
                }
            }
        } catch (err) {
            console.error(`清理目录失败: ${dir}, 错误: ${err.message}`);
        }
    }

    console.log(`清理完成，共删除 ${totalDeleted} 个文件`);
}

/**
 * 启动应用
 */
async function start() {
    try {
        // 初始化
        await initialize();

        // 立即执行一次
        console.log('执行首次任务...');
        await mainTask();

        // 启动定时任务
        console.log(`\n启动定时任务, 执行周期: ${CRON_SCHEDULE}`);
        console.log('等待下一次执行...\n');

        cron.schedule(CRON_SCHEDULE, mainTask);
        console.log('定时任务已启动');

        // 启动清理任务 - 每天0点执行
        console.log('\n启动清理任务, 执行周期: 每天 0:00');
        cron.schedule('0 0 * * *', cleanupOldFiles);
        console.log('清理任务已启动');

    } catch (error) {
        console.error('应用启动失败:', error);
        process.exit(1);
    }
}

// 启动应用
start();

// 优雅退出处理
const shutdown = async (signal) => {
    console.log(`\n收到 ${signal} 信号，正在关闭应用...`);

    // 关闭 Matrix 客户端
    if (isMatrixInitialized()) {
        await closeMatrix();
    }

    if (mongoClient) {
        await mongoClient.close();
        console.log('MongoDB 连接已关闭');
    }

    console.log('应用已关闭');
    process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

