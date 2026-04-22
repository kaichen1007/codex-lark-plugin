import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildFeishuOAuthAuthorizeUrl,
  readPersistedUserToken,
  writePersistedUserToken
} from "../lib/oauth-user-token.js";

test("buildFeishuOAuthAuthorizeUrl 会生成包含 app_id、scope 与 state 的授权链接", () => {
  const url = buildFeishuOAuthAuthorizeUrl({
    appId: "cli_test",
    redirectUri: "http://127.0.0.1:3333/callback",
    scope: ["offline_access", "drive:drive:readonly"],
    state: "state_123"
  });

  assert.equal(url.origin, "https://accounts.feishu.cn");
  assert.equal(url.pathname, "/open-apis/authen/v1/authorize");
  assert.equal(url.searchParams.get("app_id"), "cli_test");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "http://127.0.0.1:3333/callback"
  );
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(
    url.searchParams.get("scope"),
    "offline_access drive:drive:readonly"
  );
  assert.equal(url.searchParams.get("state"), "state_123");
});

test("writePersistedUserToken 与 readPersistedUserToken 会保留 token 元数据", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "codex-lark-plugin-oauth-test-")
  );
  const tokenPath = path.join(directory, "user-token.json");

  await writePersistedUserToken(tokenPath, {
    userAccessToken: "u_saved",
    userRefreshToken: "ur_saved",
    userAccessTokenExpiresAt: 123456,
    userRefreshTokenExpiresAt: 654321,
    scope: "offline_access drive:drive:readonly",
    tokenType: "Bearer",
    userName: "陈凯"
  });

  const persisted = await readPersistedUserToken(tokenPath);

  assert.equal(persisted.userAccessToken, "u_saved");
  assert.equal(persisted.userRefreshToken, "ur_saved");
  assert.equal(persisted.userAccessTokenExpiresAt, 123456);
  assert.equal(persisted.userRefreshTokenExpiresAt, 654321);
  assert.equal(persisted.scope, "offline_access drive:drive:readonly");
  assert.equal(persisted.tokenType, "Bearer");
  assert.equal(persisted.userName, "陈凯");
});
