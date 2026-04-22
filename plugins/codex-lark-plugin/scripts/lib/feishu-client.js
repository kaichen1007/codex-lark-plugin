const defaultBaseUrl = "https://open.feishu.cn/open-apis/";
const defaultTokenRefreshBufferMs = 60 * 1000;
const supportedTokenModes = new Set(["tenant", "user"]);
const supportedAuthModes = new Set(["tenant", "user", "app"]);

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

function normalizeTokenMode(value) {
  const tokenMode = normalizeText(value || "tenant").toLowerCase();

  if (!supportedTokenModes.has(tokenMode)) {
    throw new Error(
      `飞书 tokenMode 仅支持 tenant 或 user，当前收到: ${value}`
    );
  }

  return tokenMode;
}

function normalizeAuthMode(value) {
  const authMode = normalizeText(value || "tenant").toLowerCase();

  if (!supportedAuthModes.has(authMode)) {
    throw new Error(
      `飞书 authMode 仅支持 tenant、user 或 app，当前收到: ${value}`
    );
  }

  return authMode;
}

function createErrorMessage(prefix, details = {}) {
  const parts = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${String(value)}`);

  return parts.length > 0 ? `${prefix} (${parts.join(", ")})` : prefix;
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

export class FeishuApiError extends Error {
  constructor(message, details = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = "FeishuApiError";
    this.status = details.status;
    this.code = details.code;
    this.requestPath = details.requestPath;
    this.requestMethod = details.requestMethod;
    this.context = details.context ?? {};
    this.details = details.details;
  }
}

export function createFeishuClient(config, options = {}) {
  const appId = normalizeText(config?.appId);
  const appSecret = normalizeText(config?.appSecret);
  const tokenMode = normalizeTokenMode(config?.tokenMode);
  const onUserTokenUpdate = options.onUserTokenUpdate;

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (typeof fetchImpl !== "function") {
    throw new Error("当前运行环境不支持 fetch，无法请求飞书 API。");
  }

  const now = options.now ?? Date.now;
  const tokenRefreshBufferMs =
    options.tokenRefreshBufferMs ?? defaultTokenRefreshBufferMs;
  const baseUrl = new URL(options.baseUrl ?? defaultBaseUrl);

  let appTokenCache = null;
  let tenantTokenCache = null;
  const initialUserAccessToken = normalizeText(config?.userAccessToken);
  const initialUserAccessTokenExpiresAt = normalizeNumber(
    config?.userAccessTokenExpiresAt
  );
  let userTokenCache =
    tokenMode === "user"
      ? {
          token: initialUserAccessToken,
          refreshToken: normalizeText(config?.userRefreshToken),
          expiresAt:
            initialUserAccessTokenExpiresAt ??
            (initialUserAccessToken ? Number.MAX_SAFE_INTEGER : 0),
          refreshExpiresAt:
            normalizeNumber(config?.userRefreshTokenExpiresAt) ?? 0,
          tokenType: normalizeText(config?.userTokenType) || "Bearer",
          scope: normalizeText(config?.userScope),
          userName: normalizeText(config?.userName),
          userId: normalizeText(config?.userId),
          openId: normalizeText(config?.openId),
          tenantKey: normalizeText(config?.tenantKey)
        }
      : null;

  function requireAppCredentials(action) {
    if (!appId || !appSecret) {
      throw new Error(`${action}时必须提供 appId 和 appSecret。`);
    }
  }

  function buildUrl(requestPath, searchParams) {
    const normalizedPath = String(requestPath ?? "").replace(/^\/+/, "");
    const url = new URL(normalizedPath, baseUrl);

    if (searchParams) {
      for (const [key, value] of Object.entries(searchParams)) {
        if (value === undefined || value === null || value === "") {
          continue;
        }
        url.searchParams.set(key, String(value));
      }
    }

    return url;
  }

  async function parseJsonResponse(response, requestContext) {
    const rawText = await safeReadText(response);

    if (!response.ok) {
      throw new FeishuApiError(
        createErrorMessage("飞书 API HTTP 请求失败", {
          method: requestContext.method,
          path: requestContext.path,
          status: response.status,
          ...requestContext.context
        }),
        {
          status: response.status,
          requestPath: requestContext.path,
          requestMethod: requestContext.method,
          context: requestContext.context,
          details: rawText
        }
      );
    }

    let parsed;

    try {
      parsed = rawText ? JSON.parse(rawText) : {};
    } catch (cause) {
      throw new FeishuApiError(
        createErrorMessage("飞书 API 返回了无法解析的 JSON", {
          method: requestContext.method,
          path: requestContext.path,
          ...requestContext.context
        }),
        {
          requestPath: requestContext.path,
          requestMethod: requestContext.method,
          context: requestContext.context,
          details: rawText,
          cause
        }
      );
    }

    if (typeof parsed.code === "number" && parsed.code !== 0) {
      throw new FeishuApiError(
        createErrorMessage("飞书 API 返回业务错误", {
          method: requestContext.method,
          path: requestContext.path,
          code: parsed.code,
          msg: parsed.msg,
          ...requestContext.context
        }),
        {
          code: parsed.code,
          requestPath: requestContext.path,
          requestMethod: requestContext.method,
          context: requestContext.context,
          details: parsed
        }
      );
    }

    return parsed;
  }

  async function sendRequest(requestPath, requestOptions = {}) {
    const method = (requestOptions.method ?? "GET").toUpperCase();
    const headers = {
      Accept: "application/json",
      ...(requestOptions.headers ?? {})
    };
    const url = buildUrl(requestPath, requestOptions.searchParams);

    if (requestOptions.body !== undefined) {
      headers["Content-Type"] = "application/json; charset=utf-8";
    }

    const authMode =
      requestOptions.auth === false
        ? null
        : requestOptions.authMode ?? tokenMode;

    if (authMode) {
      headers.Authorization = `Bearer ${await getAccessTokenForMode(authMode)}`;
    }

    let response;

    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body:
          requestOptions.body === undefined
            ? undefined
            : JSON.stringify(requestOptions.body)
      });
    } catch (cause) {
      throw new FeishuApiError(
        createErrorMessage("请求飞书 API 失败", {
          method,
          path: requestPath,
          ...requestOptions.context
        }),
        {
          requestPath,
          requestMethod: method,
          context: requestOptions.context,
          cause
        }
      );
    }

    return parseJsonResponse(response, {
      method,
      path: requestPath,
      context: requestOptions.context
    });
  }

  async function getTenantAccessToken(options = {}) {
    requireAppCredentials("获取 tenant_access_token");
    const currentTime = now();

    if (
      !options.forceRefresh &&
      tenantTokenCache?.token &&
      tenantTokenCache.expiresAt > currentTime
    ) {
      return tenantTokenCache.token;
    }

    // 官方文档：自建应用通过 auth/v3/tenant_access_token/internal 获取 token，
    // 请求体字段为 app_id / app_secret，返回 tenant_access_token / expire。
    // Source: https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal
    const payload = await sendRequest("auth/v3/tenant_access_token/internal", {
      method: "POST",
      auth: false,
      body: {
        app_id: appId,
        app_secret: appSecret
      }
    });

    if (
      !normalizeText(payload.tenant_access_token) ||
      typeof payload.expire !== "number"
    ) {
      throw new FeishuApiError("飞书 tenant_access_token 响应缺少必要字段。", {
        requestPath: "auth/v3/tenant_access_token/internal",
        requestMethod: "POST",
        details: payload
      });
    }

    const expiresAt = currentTime + Math.max(payload.expire * 1000 - tokenRefreshBufferMs, 0);
    tenantTokenCache = {
      token: payload.tenant_access_token,
      expiresAt
    };

    return tenantTokenCache.token;
  }

  async function getAppAccessToken(options = {}) {
    requireAppCredentials("获取 app_access_token");
    const currentTime = now();

    if (
      !options.forceRefresh &&
      appTokenCache?.token &&
      appTokenCache.expiresAt > currentTime
    ) {
      return appTokenCache.token;
    }

    const payload = await sendRequest("auth/v3/app_access_token/internal", {
      method: "POST",
      auth: false,
      body: {
        app_id: appId,
        app_secret: appSecret
      }
    });

    if (
      !normalizeText(payload.app_access_token) ||
      typeof payload.expire !== "number"
    ) {
      throw new FeishuApiError("飞书 app_access_token 响应缺少必要字段。", {
        requestPath: "auth/v3/app_access_token/internal",
        requestMethod: "POST",
        details: payload
      });
    }

    const expiresAt = currentTime + Math.max(payload.expire * 1000 - tokenRefreshBufferMs, 0);
    appTokenCache = {
      token: payload.app_access_token,
      expiresAt
    };

    return appTokenCache.token;
  }

  function buildUserTokenRecord(payload) {
    const data = payload?.data ?? payload ?? {};
    const accessToken = normalizeText(data.access_token);
    const refreshToken = normalizeText(data.refresh_token);
    const expiresIn = normalizeNumber(data.expires_in);
    const refreshExpiresIn = normalizeNumber(data.refresh_expires_in);

    if (!accessToken || typeof expiresIn !== "number") {
      throw new FeishuApiError("飞书 user_access_token 响应缺少必要字段。", {
        details: payload
      });
    }

    return {
      token: accessToken,
      refreshToken,
      expiresAt: now() + Math.max(expiresIn * 1000 - tokenRefreshBufferMs, 0),
      refreshExpiresAt:
        typeof refreshExpiresIn === "number"
          ? now() + Math.max(refreshExpiresIn * 1000 - tokenRefreshBufferMs, 0)
          : 0,
      tokenType: normalizeText(data.token_type) || "Bearer",
      scope: normalizeText(data.scope),
      userName: normalizeText(data.name),
      userId: normalizeText(data.user_id),
      openId: normalizeText(data.open_id),
      tenantKey: normalizeText(data.tenant_key)
    };
  }

  async function persistUserTokenCache() {
    if (!userTokenCache || typeof onUserTokenUpdate !== "function") {
      return;
    }

    await Promise.resolve(
      onUserTokenUpdate({
        userAccessToken: userTokenCache.token,
        userRefreshToken: userTokenCache.refreshToken,
        userAccessTokenExpiresAt: userTokenCache.expiresAt,
        userRefreshTokenExpiresAt: userTokenCache.refreshExpiresAt,
        tokenType: userTokenCache.tokenType,
        scope: userTokenCache.scope,
        userName: userTokenCache.userName,
        userId: userTokenCache.userId,
        openId: userTokenCache.openId,
        tenantKey: userTokenCache.tenantKey
      })
    );
  }

  async function exchangeCodeForUserAccessToken(options = {}) {
    const code = normalizeText(options.code);

    if (!code) {
      throw new Error("获取 user_access_token 时必须提供授权回调 code。");
    }

    const payload = await sendRequest("authen/v1/access_token", {
      method: "POST",
      authMode: "app",
      body: {
        grant_type: "authorization_code",
        code,
        ...(normalizeText(options.redirectUri)
          ? { redirect_uri: normalizeText(options.redirectUri) }
          : {})
      }
    });

    userTokenCache = buildUserTokenRecord(payload);
    await persistUserTokenCache();
    return userTokenCache;
  }

  async function refreshUserAccessToken(options = {}) {
    const refreshToken =
      normalizeText(options.refreshToken) || normalizeText(userTokenCache?.refreshToken);

    if (!refreshToken) {
      throw new Error("刷新 user_access_token 时缺少 refresh_token。");
    }

    const payload = await sendRequest("authen/v1/refresh_access_token", {
      method: "POST",
      authMode: "app",
      body: {
        grant_type: "refresh_token",
        refresh_token: refreshToken
      }
    });

    userTokenCache = buildUserTokenRecord(payload);
    await persistUserTokenCache();
    return userTokenCache.token;
  }

  async function getUserAccessToken(options = {}) {
    const currentTime = now();

    if (
      !options.forceRefresh &&
      userTokenCache?.token &&
      userTokenCache.expiresAt > currentTime
    ) {
      return userTokenCache.token;
    }

    if (userTokenCache?.refreshToken) {
      return refreshUserAccessToken();
    }

    throw new Error(
      "当前配置为 user_access_token 模式，但未提供可用的 user_access_token 或 refresh_token。"
    );
  }

  async function getAccessTokenForMode(mode) {
    switch (normalizeAuthMode(mode)) {
      case "app":
        return getAppAccessToken();
      case "tenant":
        return getTenantAccessToken();
      case "user":
        return getUserAccessToken();
      default:
        throw new Error(`未知飞书 tokenMode: ${mode}`);
    }
  }

  async function request(requestPath, requestOptions = {}) {
    return sendRequest(requestPath, requestOptions);
  }

  function inspectTokenCache() {
    const activeCache =
      tokenMode === "user" ? userTokenCache : tenantTokenCache;
    return activeCache ? { ...activeCache } : null;
  }

  return {
    getAppAccessToken,
    getTenantAccessToken,
    getUserAccessToken,
    exchangeCodeForUserAccessToken,
    refreshUserAccessToken,
    request,
    inspectTokenCache,
    inspectAppTokenCache() {
      return appTokenCache ? { ...appTokenCache } : null;
    },
    inspectUserTokenCache() {
      return userTokenCache ? { ...userTokenCache } : null;
    }
  };
}
