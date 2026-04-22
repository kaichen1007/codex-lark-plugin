import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const defaultOauthBaseUrl = "https://accounts.feishu.cn/open-apis/";
const defaultUserTokenPath = path.join(
  os.homedir(),
  ".codex",
  "codex-lark-plugin",
  "feishu-user-token.json"
);

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNumber(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function normalizeScope(scope) {
  if (Array.isArray(scope)) {
    return scope
      .map((item) => normalizeText(item))
      .filter(Boolean)
      .join(" ");
  }

  return normalizeText(scope);
}

export function resolveUserTokenPath(inputPath) {
  const normalized = normalizeText(inputPath);

  if (!normalized) {
    return defaultUserTokenPath;
  }

  if (path.isAbsolute(normalized)) {
    return normalized;
  }

  return path.resolve(process.cwd(), normalized);
}

export function buildFeishuOAuthAuthorizeUrl(options = {}) {
  const appId = normalizeText(options.appId);
  const redirectUri = normalizeText(options.redirectUri);
  const state = normalizeText(options.state);
  const scope = normalizeScope(options.scope);

  if (!appId) {
    throw new Error("构建飞书 OAuth 授权链接时必须提供 appId。");
  }

  if (!redirectUri) {
    throw new Error("构建飞书 OAuth 授权链接时必须提供 redirectUri。");
  }

  const url = new URL("authen/v1/authorize", options.baseUrl ?? defaultOauthBaseUrl);
  url.searchParams.set("app_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");

  if (scope) {
    url.searchParams.set("scope", scope);
  }

  if (state) {
    url.searchParams.set("state", state);
  }

  return url;
}

export function normalizePersistedUserToken(rawToken = {}) {
  const normalized = {
    userAccessToken: normalizeText(
      rawToken.userAccessToken ?? rawToken.access_token ?? rawToken.accessToken
    ),
    userRefreshToken: normalizeText(
      rawToken.userRefreshToken ?? rawToken.refresh_token ?? rawToken.refreshToken
    ),
    userAccessTokenExpiresAt:
      normalizeNumber(rawToken.userAccessTokenExpiresAt) ??
      normalizeNumber(rawToken.access_token_expires_at),
    userRefreshTokenExpiresAt:
      normalizeNumber(rawToken.userRefreshTokenExpiresAt) ??
      normalizeNumber(rawToken.refresh_token_expires_at),
    tokenType: normalizeText(rawToken.tokenType ?? rawToken.token_type),
    scope: normalizeScope(rawToken.scope),
    userName: normalizeText(rawToken.userName ?? rawToken.name),
    userId: normalizeText(rawToken.userId ?? rawToken.user_id),
    openId: normalizeText(rawToken.openId ?? rawToken.open_id),
    tenantKey: normalizeText(rawToken.tenantKey ?? rawToken.tenant_key)
  };

  return Object.fromEntries(
    Object.entries(normalized).filter(([, value]) => value !== "" && value !== undefined)
  );
}

export async function readPersistedUserToken(tokenPath) {
  const resolvedPath = resolveUserTokenPath(tokenPath);

  try {
    const raw = await fs.readFile(resolvedPath, "utf8");
    return normalizePersistedUserToken(JSON.parse(raw));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if (error.code === "ENOENT") {
        return null;
      }
    }

    throw error;
  }
}

export async function writePersistedUserToken(tokenPath, token) {
  const resolvedPath = resolveUserTokenPath(tokenPath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  const normalized = normalizePersistedUserToken(token);
  await fs.writeFile(
    resolvedPath,
    `${JSON.stringify(normalized, null, 2)}\n`,
    "utf8"
  );
  return resolvedPath;
}
