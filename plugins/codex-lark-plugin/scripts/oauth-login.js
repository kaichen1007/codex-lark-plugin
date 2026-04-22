import http from "node:http";
import process from "node:process";
import { randomUUID } from "node:crypto";

import { createFeishuClient } from "./lib/feishu-client.js";
import {
  buildFeishuOAuthAuthorizeUrl,
  resolveUserTokenPath,
  writePersistedUserToken
} from "./lib/oauth-user-token.js";

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeScope(rawValue) {
  return normalizeText(rawValue)
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function createCallbackPage(title, message) {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
  </head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 32px;">
    <h1>${title}</h1>
    <p>${message}</p>
  </body>
</html>`;
}

const appId = normalizeText(process.env.LARK_FEISHU_APP_ID);
const appSecret = normalizeText(process.env.LARK_FEISHU_APP_SECRET);
const redirectUri =
  normalizeText(process.env.LARK_FEISHU_OAUTH_REDIRECT_URI) ||
  "http://127.0.0.1:3333/callback";
const scope = normalizeScope(
  process.env.LARK_FEISHU_OAUTH_SCOPE ||
    "offline_access drive:drive:readonly space:document:retrieve"
);
const timeoutMs = Number(process.env.LARK_FEISHU_OAUTH_TIMEOUT_MS || 300_000);
const state = randomUUID();
const redirectUrl = new URL(redirectUri);
const tokenPath = resolveUserTokenPath(process.env.LARK_FEISHU_USER_TOKEN_PATH);

if (!appId || !appSecret) {
  throw new Error(
    "运行 OAuth 登录脚本前必须提供 LARK_FEISHU_APP_ID 和 LARK_FEISHU_APP_SECRET。"
  );
}

if (redirectUrl.protocol !== "http:") {
  throw new Error(
    "当前 OAuth 登录脚本仅支持 http 回调地址，例如 http://127.0.0.1:3333/callback。"
  );
}

const client = createFeishuClient({
  appId,
  appSecret,
  tokenMode: "user"
});

const authorizeUrl = buildFeishuOAuthAuthorizeUrl({
  appId,
  redirectUri,
  state,
  scope
});

const callbackResult = await new Promise((resolve, reject) => {
  const server = http.createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url ?? "/", redirectUri);

      if (requestUrl.pathname !== redirectUrl.pathname) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not Found");
        return;
      }

      const error = normalizeText(requestUrl.searchParams.get("error"));
      const code = normalizeText(requestUrl.searchParams.get("code"));
      const returnedState = normalizeText(requestUrl.searchParams.get("state"));

      if (error) {
        response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        response.end(
          createCallbackPage("飞书授权失败", `飞书返回错误：${error}`)
        );
        reject(new Error(`飞书授权失败：${error}`));
        return;
      }

      if (!code) {
        response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        response.end(
          createCallbackPage("缺少授权码", "回调地址中没有收到 code。")
        );
        reject(new Error("飞书 OAuth 回调缺少 code。"));
        return;
      }

      if (returnedState !== state) {
        response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        response.end(
          createCallbackPage("状态校验失败", "state 不匹配，已拒绝本次授权。")
        );
        reject(new Error("飞书 OAuth 回调 state 不匹配。"));
        return;
      }

      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        createCallbackPage(
          "授权成功",
          "user_access_token 已获取完成，可以关闭当前页面回到终端。"
        )
      );
      resolve({ code });
    } catch (error) {
      reject(error);
    } finally {
      setTimeout(() => server.close(), 50).unref();
    }
  });

  server.once("error", reject);
  server.listen(
    Number(redirectUrl.port || (redirectUrl.protocol === "https:" ? 443 : 80)),
    redirectUrl.hostname,
    () => {
      process.stdout.write(
        [
          `请在浏览器中打开以下链接完成飞书授权：`,
          String(authorizeUrl),
          ``,
          `授权成功后，token 将写入：${tokenPath}`,
          `如果飞书开放平台还没配置回调地址，请先把这个地址加入安全设置：${redirectUri}`
        ].join("\n") + "\n"
      );
    }
  );

  const timeout = setTimeout(() => {
    server.close();
    reject(new Error(`等待飞书 OAuth 回调超时（${timeoutMs}ms）。`));
  }, timeoutMs);
  timeout.unref();
});

const token = await client.exchangeCodeForUserAccessToken({
  code: callbackResult.code,
  redirectUri
});

await writePersistedUserToken(tokenPath, {
  userAccessToken: token.token,
  userRefreshToken: token.refreshToken,
  userAccessTokenExpiresAt: token.expiresAt,
  userRefreshTokenExpiresAt: token.refreshExpiresAt,
  tokenType: token.tokenType,
  scope: token.scope,
  userName: token.userName,
  userId: token.userId,
  openId: token.openId,
  tenantKey: token.tenantKey
});

process.stdout.write(
  `${JSON.stringify(
    {
      tokenPath,
      tokenMode: "user",
      userName: token.userName || null,
      userId: token.userId || null,
      openId: token.openId || null,
      tenantKey: token.tenantKey || null,
      nextEnv: {
        LARK_DOCS_SOURCE: "feishu",
        LARK_FEISHU_TOKEN_MODE: "user",
        LARK_FEISHU_USER_TOKEN_PATH: tokenPath
      }
    },
    null,
    2
  )}\n`
);
