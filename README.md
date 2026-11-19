# Umami MCP

给 Agent 使用的本地只读 MCP 服务。通过 `stdio` 连接 MCP 客户端，通过 HTTP API 查询自托管 Umami。支持个人和团队网站，按 Umami 账号的现有权限读取数据。

## 从 Magpie 安装

在 Magpie 的 **Library → MCP servers → Market** 搜索 `io.github.MrLinWang/umami-mcp`，选择 **Umami Analytics (Read-only)**。添加时填写自己的 `UMAMI_URL` 和 `UMAMI_API_TOKEN`，再选择使用它的 Agent。运行 MCP 的机器需要在 `PATH` 上有 `npx` 和 Node.js 18.20 或更新版本。 [Magpie Library](https://usemagpie.ai/docs/library#mcp-servers)

## 接入其他 MCP 客户端

使用 `npx -y mrlinwang-umami-mcp@0.1.0` 作为命令。已有 Umami 配置文件时，可以通过 `--env-file` 指定其绝对路径。

```json
{
  "mcpServers": {
    "umami": {
      "command": "npx",
      "args": [
        "-y",
        "mrlinwang-umami-mcp@0.1.0",
        "--env-file",
        "/absolute/path/to/umami.env"
      ]
    }
  }
}
```

也可以通过客户端的 `env` 配置提供连接变量。从源码运行时，在项目目录执行 `npm ci`，将 [.env.example](.env.example) 复制为 `.env` 后填写配置，再用 `node /absolute/path/to/src/server.js` 作为启动命令。

| 变量 | 用途 |
| --- | --- |
| `UMAMI_URL` | 实例地址，如 `https://analytics.example.com`。有部署子路径时一并填写，服务会追加 `/api`。 |
| `UMAMI_API_TOKEN` / `UMAMI_TOKEN` | Umami API key 或登录令牌。两者都有值时优先使用 `UMAMI_API_TOKEN`。 |
| `UMAMI_WEBSITE_ID` | 可选。工具可以省略该默认站点的 `websiteId`。 |
| `UMAMI_TIMEZONE` | 可选。用于自然日、自然月和流量趋势，例如 `Asia/Shanghai`，默认 `UTC`。 |

配置按来源读取。指定 `--env-file` 时使用该文件。否则，进程环境有 Umami 连接配置时使用进程环境，其余情况使用项目根目录的 `.env`。

遇到 HTTP 401 时，检查令牌是否过期以及账号是否有目标网站或团队的访问权限。支持 API key 的 Umami 实例可以从账号设置创建 API key。 [Umami 认证文档](https://docs.umami.is/docs/api/authentication)

## 获取令牌

项目提供 `scripts/get-umami-token.py`，只需要 Python 3 标准库。它支持密码输入、环境变量读取密码、双重验证，以及通过登录令牌创建长期 API key。默认只将原始令牌输出到标准输出。

交互式登录并输出登录令牌：

```bash
python3 scripts/get-umami-token.py --url https://analytics.example.com
```

从环境变量读取密码，避免密码出现在命令行中：

```bash
read -r -s -p "Umami password: " UMAMI_PASSWORD
export UMAMI_PASSWORD
python3 scripts/get-umami-token.py \
  --url https://analytics.example.com --username your-username --password-env UMAMI_PASSWORD
unset UMAMI_PASSWORD
```

创建长期 API key，并写入指定配置文件。脚本会创建配置文件，或更新其中的 `UMAMI_API_TOKEN`，保留其他配置，并将文件权限设为 `0600`。已有 `UMAMI_URL` 必须与本次登录的实例一致：

```bash
python3 scripts/get-umami-token.py --url https://analytics.example.com \
  --create-key --key-name mcp --env-file .env
```

也可以复用已有的登录令牌或 API key，不重复登录：

```bash
python3 scripts/get-umami-token.py --url https://analytics.example.com --token-env UMAMI_TOKEN \
  --create-key --key-name mcp --env-file .env
```

脚本也可从环境变量 `UMAMI_URL` 读取实例地址。启用 2FA 时会交互式请求验证码或备用码；自动化登录可通过 `--otp` 传入六位验证码。

未指定 `--create-key` 时返回的是登录令牌，也可作为 MCP 的 `UMAMI_API_TOKEN` 使用。`--create-key` 创建可独立吊销的长期 API key，需要实例支持该接口，完整密钥只在创建时返回一次。交互提示输出到标准错误，密码不回显；未使用 `--env-file` 时，标准输出只包含原始凭据。在 Umami Cloud 上，请从控制台创建 API key，登录令牌流程仅适用于自托管实例。

## 工具

| 工具 | 返回内容 |
| --- | --- |
| `list_teams` | 令牌可访问的团队及其 ID。 |
| `list_websites` | 站点名称、域名和 ID。查询团队站点时先取得 `teamId`，再传给此工具。 |
| `get_website_stats` | 浏览量、访客数、访问次数、跳出次数和总访问时长。 |
| `get_website_traffic` | 按分钟、小时、日、月或年分组的浏览量和会话趋势。 |
| `get_website_metrics` | 页面、来源、地区、浏览器、设备、屏幕、事件或 UTM 等维度的排名。 |
| `get_sessions` | 访客会话及设备、地区、访问次数、浏览量、自定义事件数和活动时间。 |
| `get_session_activity` | 单个会话的页面和事件明细，包括 `visitId`、来源和时间。 |
| `get_events` | 分页查看页面浏览和自定义事件，可按 `eventType` 筛选。 |
| `get_realtime` | 最近 30 分钟的实时访问概况。 |

带日期的工具默认查询过去 7 天。可用 `period` 选择 `today`、`24h`、`7d`、`30d` 或 `0month`（本自然月），也可以同时传 `startAt` 和 `endAt`，使用带时区偏移的 ISO 8601 时间或 Unix 毫秒时间戳。工具会返回实际查询使用的 `range`，可将其中的字段作为后续分页或查询活动明细的参数。单页最多 100 条。会话活动接口最多返回 500 条，命中上限时工具会标记 `isCapped`。

### 示例

调用 `get_sessions` 查询 `example.com` 本月的新加坡 Chrome/Windows 笔记本访客。这里使用 `UMAMI_WEBSITE_ID` 配置的默认站点。

```json
{
  "period": "0month",
  "filters": {
    "hostname": "example.com",
    "country": "SG",
    "browser": "chrome",
    "os": "Windows 10",
    "device": "laptop"
  },
  "pageSize": 25
}
```

根据返回的 `count` 和 `pageSize` 翻页，再选出 `visits` 为 1 或 2 的记录。如果响应标记 `isCapped`，可缩小日期范围来补查。用访客记录的 `id` 作为 `sessionId` 调用 `get_session_activity`，按 `visitId` 把同一次访问的页面和事件归在一起。`views` 是页面浏览量，`events` 是自定义事件数。 [会话 API](https://docs.umami.is/docs/api-reference/get-website-sessions) · [会话活动 API](https://docs.umami.is/docs/api-reference/get-website-session-activity)

## 发布

将 `package.json` 和 `server.json` 中的版本更新为同一版本（包括 `packages[0].version`），并同步锁文件。用 `npm pack --dry-run` 检查包内文件，再发布 npm 包和 Registry 条目。

```bash
npm publish --access public
mcp-publisher login github
mcp-publisher publish
```

Registry 登录使用拥有 `io.github.MrLinWang/` 命名空间的 GitHub 账号。发布后在 Magpie 的 MCP 市场搜索完整 Registry ID。 [MCP Registry 发布指南](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx)
