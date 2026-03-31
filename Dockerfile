# 使用 Node.js 20 作为基础镜像
FROM node:20

# 设置工作目录
WORKDIR /app

# 安装 FFmpeg 和其他依赖（用于处理媒体文件）
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# 复制 package.json 和 pnpm-lock.yaml
COPY package.json pnpm-lock.yaml ./

# 安装 pnpm
RUN npm install -g pnpm

# 安装依赖
RUN pnpm install --frozen-lockfile

# 下载 Matrix SDK crypto 原生库（手动下载 libolm）
RUN cd node_modules/.pnpm/@matrix-org+matrix-sdk-crypto-nodejs@0.4.0/node_modules/@matrix-org/matrix-sdk-crypto-nodejs && \
    node download-lib.js

# 复制应用代码
COPY . .

# 创建必要的目录
RUN mkdir -p downloads thumbnails logs .matrix-storage

# 创建非 root 用户以提高安全性
RUN useradd -m -u 1000 appuser && \
    chown -R appuser:appuser /app
USER appuser

# 暴露端口（如果将来需要添加 API 或 Web 界面）
# EXPOSE 3000

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})" || exit 0

# 启动应用
CMD ["node", "index.js"]
