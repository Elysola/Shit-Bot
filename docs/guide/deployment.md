# 部署指南

## Docker 部署（推荐）

项目提供 `Dockerfile` 和 `docker-compose.yml`，一键部署。

```bash
# 构建并启动
docker compose up -d

# 查看日志
docker compose logs -f

# 重启
docker compose restart

# 停止
docker compose down
```

### docker-compose.yml

```yaml
services:
  shit-bot:
    image: ghcr.io/elysola/shit-bot:latest
    container_name: shit-bot
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./config.yaml:/app/config.yaml
      - ./data:/app/data
    environment:
      - TZ=Asia/Shanghai
```

### 数据持久化

- `config.yaml`：配置文件，挂载到 `/app/config.yaml`
- `data/`：SQLite 数据库和缓存，挂载到 `/app/data`

## 从源码部署

### 使用 Bun

```bash
# 安装依赖
bun install

# 构建
bun run build

# 运行
bun run start

# 或使用 PM2
npm install -g pm2
pm2 start dist/index.js --name shit-bot
```

### 使用 Docker 本地构建

```bash
docker build -t shit-bot .
docker run -d \
  --name shit-bot \
  -v $(pwd)/config.yaml:/app/config.yaml \
  -v $(pwd)/data:/app/data \
  -p 3000:3000 \
  --restart unless-stopped \
  shit-bot
```

## 环境变量

在 `.env` 文件中设置：

```bash
# Twitter 认证（覆盖 config.yaml）
TWITTER_AUTH_TOKEN=your_auth_token
TWITTER_CT0=your_ct0

# AI API
AI_API_URL=https://api.openai.com/v1
AI_API_KEY=sk-xxx
```

## 外部插件

如需加载外部插件，创建插件目录并挂载到容器：

```yaml
volumes:
  - ./plugins:/app/data/plugins
```

然后在 `config.yaml` 中配置：

```yaml
pluginsDir: /app/data/plugins
plugins:
  - name: my-plugin
    enabled: true
```
