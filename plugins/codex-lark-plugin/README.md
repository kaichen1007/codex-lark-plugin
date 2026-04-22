# codex-lark-plugin

这是 marketplace 中的单个插件目录。

## 当前定位

插件第一版聚焦：

- 团队知识库文档检索
- 项目文档摘要
- 最近更新查询与文档差异比较

当前支持两种数据源模式：

- `sample`：读取仓库内样本文档 fixture，适合本地开发、CI 和无凭证验证
- `feishu`：读取真实飞书 folder / wiki 根入口，先同步到本地索引后再提供 MCP 检索

真实飞书模式下又支持两种鉴权方式：

- `tenant`：应用身份，适合企业共享目录、wiki 根等应用可读资源
- `user`：用户身份，适合“我的文件夹”或仅当前用户可访问的云文档资源

## 目录说明

- `.codex-plugin/plugin.json`：插件 manifest
- `skills/`：面向 Codex 的知识检索技能定义
- `scripts/`：样本文档同步、索引构建与 MCP server 脚本
- `data/`：用于本地验证的飞书样本文档 fixture
- `assets/`：图标、截图等静态资源
- `.mcp.json`：MCP 服务配置

## 发布说明

该插件由上层 marketplace 仓库通过：

- `.agents/plugins/marketplace.json`

进行暴露。发布到 GitHub 后，推荐用户通过：

```bash
codex marketplace add https://github.com/<your-github-username>/codex-lark-plugin.git
```

来接入整个 marketplace。

## 本地运行

### Sample 模式

```bash
npm run sync:sample
node plugins/codex-lark-plugin/scripts/server.js
```

### 真实飞书模式

对外使用时，优先让用户在**本地 MCP 配置**的 `env` 中填写飞书参数，而不是手工设置 shell 环境变量。仓库中的 `.mcp.json` 只作为模板，不应提交真实 secret。

`feishu` 模式至少需要这些字段：

- `LARK_DOCS_SOURCE=feishu`
- `LARK_FEISHU_SYNC_ROOTS`
- `LARK_INDEX_PATH`

默认鉴权模式是 `tenant`，此时还需要：

- `LARK_FEISHU_TOKEN_MODE=tenant`
- `LARK_FEISHU_APP_ID`
- `LARK_FEISHU_APP_SECRET`

如果你要读取“我的文件夹”之类的个人文档，改用 `user` 模式：

- `LARK_FEISHU_TOKEN_MODE=user`
- `LARK_FEISHU_USER_TOKEN_PATH`

`LARK_FEISHU_SYNC_ROOTS` 的格式是 JSON 数组，例如：

```json
[
  { "type": "folder", "token": "fldcn_xxxxx" },
  { "type": "wiki", "token": "wikcn_xxxxx" }
]
```

`user` 模式推荐先跑一次本地 OAuth 登录脚本：

```bash
LARK_FEISHU_APP_ID=cli_xxx \
LARK_FEISHU_APP_SECRET=secret_xxx \
LARK_FEISHU_OAUTH_REDIRECT_URI=http://127.0.0.1:3333/callback \
npm run login:feishu-oauth
```

脚本会打印一条授权链接。浏览器完成登录后，会把 `user_access_token` 和 `refresh_token`
写到本地 token 文件，默认路径是：

```text
~/.codex/codex-lark-plugin/feishu-user-token.json
```

然后把 MCP 配置切到：

```json
{
  "LARK_DOCS_SOURCE": "feishu",
  "LARK_FEISHU_TOKEN_MODE": "user",
  "LARK_FEISHU_USER_TOKEN_PATH": "~/.codex/codex-lark-plugin/feishu-user-token.json"
}
```

可用命令：

```bash
# 强制同步真实飞书文档到本地索引
npm run sync:feishu

# 启动本地 OAuth 登录并生成 user_access_token
npm run login:feishu-oauth

# 使用真实凭证做一次最小 smoke test
npm run test:feishu-smoke
```

`compare_doc_changes` 在真实飞书模式下基于**本地同步快照**工作：

- 第一次同步后，每篇文档只有 1 个本地 snapshot，还不能比较差异
- 对同一批 root 再同步一次后，如果文档正文发生变化，就会累积到 `revisions[]`
- 从第二次同步开始，可对已有多份 snapshot 的文档执行 diff

### 构建与测试

```bash
npm test
npm run build
```
