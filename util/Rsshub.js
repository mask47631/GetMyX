import { init, request } from 'rsshub';
import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

let rsshubConfig = {
    TWITTER_AUTH_TOKEN: process.env.TWITTER_AUTH_TOKEN
};
if (process.env.PROXY_URI !== undefined && process.env.PROXY_URI !== '' && process.env.PROXY_URI !== 'null') {
    rsshubConfig.PROXY_URI = process.env.PROXY_URI;
}

let mongoClient = null;
let db = null;
let itemsCollection = null;

async function initMongo() {
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
    const dbName = process.env.MONGODB_DATABASE || 'getmyx';
    const collectionName = process.env.MONGODB_COLLECTION || 'items';

    mongoClient = new MongoClient(uri);
    await mongoClient.connect();
    db = mongoClient.db(dbName);
    itemsCollection = db.collection(collectionName);

    // 创建唯一索引确保 link 字段唯一
    await itemsCollection.createIndex({ link: 1 }, { unique: true });
    console.log('MongoDB connected');
}

async function initRsshub() {
    await init(rsshubConfig);
    console.log('Rsshub initialized');
}

async function get_home_latest(params) {
    const rssData = await request('/twitter/home_latest/readable=1&onlyMedia=1', params);
    if (rssData.item && rssData.item.length > 0) {
        return rssData.item;
    }
    return null;
}

async function getMedia() {
    const item = await get_home_latest();
    let media = {
        img: [],
        video: []
    }
    if (!item) {
        return media;
    }
    // 从环境变量获取过滤关键词（英文逗号分隔）
    const filterKeywords = process.env.FILTER_KEYWORDS
        ? process.env.FILTER_KEYWORDS.split(',').map(k => k.trim().toLowerCase()).filter(k => k)
        : [];
    for (let i = 0; i < item.length; i++) {
        const element = item[i];
        // console.log(element.description);

        // HTML 解码函数
        const decodeHtmlEntities = (str) => {
            return str.replace(/&amp;/g, '&')
                      .replace(/&lt;/g, '<')
                      .replace(/&gt;/g, '>')
                      .replace(/&quot;/g, '"')
                      .replace(/&#39;/g, "'");
        };

        // Check if link already exists in MongoDB
        if (element.link) {
            const exists = await itemsCollection.findOne({ link: element.link });
            if (exists) {
                // console.log(`Link already exists, skipping: ${element.link}`);
                continue;
            }
            console.log(`New link found: ${element.link}`);
            // Insert new link to MongoDB
            await itemsCollection.insertOne({ link: element.link, timestamp: new Date() });
        }

        if (!element.description) {
            continue;
        }

        // 关键词过滤：如果 description 包含任意过滤关键词，则跳过
        if (filterKeywords.length > 0) {
            const descriptionLower = element.description.toLowerCase();
            const hasFilteredKeyword = filterKeywords.some(keyword => descriptionLower.includes(keyword));
            if (hasFilteredKeyword) {
                console.log(`Skipping item with filtered keyword: ${element.link}`);
                continue;
            }
        }
        // Extract video URLs from <video> tags (support multiple videos)
        const videoMatches = element.description.matchAll(/<video[^>]*src=["']([^"']+)["'][^>]*>/g);
        for (const match of videoMatches) {
            if (match[1]) {
                // 解码 HTML 实体
                let videoUrl = decodeHtmlEntities(match[1]);
                media.video.push(videoUrl);
            }
        }

        // Extract image URLs from <img> tags
        const imgMatches = element.description.matchAll(/<img[^>]*src=["']([^"']+)["'][^>]*>/g);
        for (const match of imgMatches) {
            if (match[1]) {
                // 解码 HTML 实体
                let imgUrl = decodeHtmlEntities(match[1]);
                media.img.push(imgUrl);
            }
        }
    }
    return media;
}
export { get_home_latest, getMedia, initRsshub, initMongo };
