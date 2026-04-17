# GetMyX

获取你自己的 Twitter/X 时间线中的媒体内容（图片和视频），并自动下载到本地或发送到 Matrix 房间。

## 功能特性

- 📥 **自动下载**：定时获取 Twitter 时间线中的图片和视频
- 🔄 **去重机制**：通过文件哈希值自动检测并跳过重复内容
- 🗑️ **自动清理**：定期清理 24 小时前的旧文件
- 🔍 **关键词过滤**：支持过滤包含特定关键词的内容
- 💬 **Matrix 集成**：可将下载的媒体自动发送到 Matrix 房间
- 🐳 **Docker 支持**：提供完整的 Docker 部署方案
- 📊 **MongoDB 存储**：保存链接和媒体信息，避免重复下载

## 快速开始

### 前置要求

- Node.js >= 18
- MongoDB
- FFmpeg（用于生成缩略图）
- Twitter/X 账号和认证令牌

### 本地运行

1. **克隆仓库**

```bash
git clone <repository-url>
cd GetMyX
```

2. **安装依赖**

```bash
pnpm install
```

3. **配置环境变量**

复制 `.env.example` 为 `.env` 并填写配置：

```bash
cp .env.example .env
```

编辑 `.env` 文件，至少配置以下必填项：

```env
TWITTER_AUTH_TOKEN=your_twitter_auth_token
MONGODB_URI=mongodb://localhost:27017
```

4. **启动应用**

```bash
node index.js
```

应用将立即执行首次任务，然后按配置的时间间隔定时执行。

## 配置说明

### 必填配置

| 变量名 | 说明 | 示例 |
|--------|------|------|
| `TWITTER_AUTH_TOKEN` | Twitter/X 认证令牌 | `your_token_here` |
| `MONGODB_URI` | MongoDB 连接字符串 | `mongodb://localhost:27017` |

### 可选配置

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `MONGODB_DATABASE` | MongoDB 数据库名 | `getmyx` |
| `MONGODB_COLLECTION` | 链接集合名 | `items` |
| `MEDIA_COLLECTION_NAME` | 媒体信息集合名 | `media` |
| `MEDIA_DOWNLOAD_DIR` | 下载目录 | `./downloads` |
| `MEDIA_THUMBNAIL_DIR` | 缩略图目录 | `./thumbnails` |
| `MEDIA_THUMBNAIL_WIDTH` | 缩略图宽度 | `720` |
| `FILTER_KEYWORDS` | 过滤关键词（逗号分隔） | `keyword1,keyword2` |
| `CRON_SCHEDULE` | 定时任务 Cron 表达式 | `*/30 * * * *` |
| `PROXY_URI` | 代理地址 | - |
| `MATRIX_HOMESERVER` | Matrix 服务器地址 | `https://matrix.org` |
| `MATRIX_USER_ID` | Matrix 用户 ID | - |
| `MATRIX_ACCESS_TOKEN` | Matrix 访问令牌 | - |
| `MATRIX_ROOM_ID` | Matrix 房间 ID | - |
| `MATRIX_IMAGE_ROOM_ID` | 图片专用房间 ID（可选） | - |
| `MATRIX_VIDEO_ROOM_ID` | 视频专用房间 ID（可选） | - |
| `MATRIX_LARGE_FILE_ROOM_ID` | 大文件专用房间 ID（可选） | - |
| `MATRIX_LARGE_FILE_THRESHOLD_MB` | 大文件阈值（MB） | `50` |
| `MATRIX_AUTO_DELETE_ON_SUCCESS` | 发送成功后自动删除本地文件 | `false` |

### 获取 Twitter 认证令牌

1. 登录 Twitter/X
2. 打开浏览器开发者工具（F12）
3. 进入 Network 标签
4. 刷新页面并查找包含 `auth_token` 的请求
5. 复制 `auth_token` 值到 `.env` 文件

### Matrix 配置（可选）

如果需要将媒体发送到 Matrix 房间：

1. 注册一个 Matrix 账号
2. 创建一个房间或加入现有房间
3. 在房间中发送 `get-room-id` 消令获取房间 ID
4. 在 Matrix 设置中获取访问令牌
5. 将以上信息填入 `.env` 文件

#### 媒体类型分流（可选）

支持将图片和视频发送到不同的房间：

- **默认行为**：所有媒体发送到 `MATRIX_ROOM_ID` 指定的房间
- **图片分流**：配置 `MATRIX_IMAGE_ROOM_ID` 后，图片发送到该房间
- **视频分流**：配置 `MATRIX_VIDEO_ROOM_ID` 后，视频发送到该房间
- **大文件分流**：配置 `MATRIX_LARGE_FILE_ROOM_ID` 和阈值后，超过阈值的文件发送到大文件房间（优先级最高）

示例配置：

```env
# 默认房间（未匹配分流规则的媒体）
MATRIX_ROOM_ID=!default_room:matrix.org

# 媒体类型分流
MATRIX_IMAGE_ROOM_ID=!image_room:matrix.org      # 图片专用房间
MATRIX_VIDEO_ROOM_ID=!video_room:matrix.org      # 视频专用房间

# 大文件分流（优先级高于类型分流）
MATRIX_LARGE_FILE_ROOM_ID=!large_file:matrix.org # 大文件房间
MATRIX_LARGE_FILE_THRESHOLD_MB=50                # 50MB 以上为大文件

# 发送成功后自动删除本地文件（节省磁盘空间）
MATRIX_AUTO_DELETE_ON_SUCCESS=true
```

## Docker 部署

1. **配置环境变量**

```bash
cp .env.docker .env
```

编辑 `.env` 文件，至少填写 `TWITTER_AUTH_TOKEN`。

2. **启动服务**

```bash
docker-compose up -d
```

3. **查看日志**

```bash
docker-compose logs -f
```

4. **停止服务**

```bash
docker-compose down
```

### Docker 配置说明

- MongoDB 运行在容器内，服务名为 `mongodb`
- 代理配置使用 `host.docker.internal` 访问宿主机代理
- 媒体文件存储在 `/app` 目录，已通过 volume 挂载到本地

## 目录结构

```
GetMyX/
├── index.js              # 主程序入口
├── util/
│   ├── Rsshub.js        # RSS 数据获取
│   ├── Media.js         # 媒体下载和处理
│   └── MatrixBot.js     # Matrix 机器人
├── downloads/           # 下载的媒体文件
├── thumbnails/          # 生成的缩略图
├── .env.example         # 环境变量示例
├── .env.docker          # Docker 环境变量示例
├── Dockerfile           # Docker 镜像配置
└── docker-compose.yml   # Docker Compose 配置
```

## 定时任务

默认配置为每 30 分钟执行一次，可通过 `CRON_SCHEDULE` 修改。

Cron 表达式格式：`分 时 日 月 周`

常见配置示例：

```env
# 每 30 分钟
CRON_SCHEDULE=*/30 * * * *

# 每小时
CRON_SCHEDULE=0 * * * *

# 每天凌晨 2 点
CRON_SCHEDULE=0 2 * * *

# 每周一早上 9 点
CRON_SCHEDULE=0 9 * * 1
```

## 自动清理

应用会每天凌晨 0 点自动清理 24 小时前的文件，包括：

- 下载目录中的媒体文件
- 缩略图目录中的缩略图

## 故障排查

### 无法连接 Twitter

- 检查 `TWITTER_AUTH_TOKEN` 是否正确
- 如果需要代理，检查 `PROXY_URI` 配置
- 确认网络连接正常

### MongoDB 连接失败

- 检查 MongoDB 是否正常运行
- 验证 `MONGODB_URI` 配置
- 确认 MongoDB 认证配置（如有）

### Matrix 发送失败

- 检查 Matrix 配置是否完整
- 验证访问令牌是否有效
- 确认机器人账号有发送权限

### FFmpeg 命令未找到

- 安装 FFmpeg：
  - macOS: `brew install ffmpeg`
  - Ubuntu: `sudo apt install ffmpeg`
  - Docker: 已包含在镜像中

## 许可证

MIT License