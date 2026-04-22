import assert from "node:assert/strict";
import test from "node:test";

import {
  createFeishuClient,
  FeishuApiError
} from "../lib/feishu-client.js";

function createJsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload);
    }
  };
}

test("getTenantAccessToken 会调用官方 token 接口并缓存结果", async () => {
  const requests = [];
  const client = createFeishuClient(
    { appId: "cli_test", appSecret: "secret_test" },
    {
      now: () => 1_000_000,
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          method: init.method,
          headers: init.headers,
          body: init.body
        });

        return createJsonResponse(200, {
          code: 0,
          msg: "ok",
          tenant_access_token: "t_cached",
          expire: 7200
        });
      }
    }
  );

  const first = await client.getTenantAccessToken();
  const second = await client.getTenantAccessToken();

  assert.equal(first, "t_cached");
  assert.equal(second, "t_cached");
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"
  );
  assert.equal(requests[0].method, "POST");
  assert.match(requests[0].body, /"app_id":"cli_test"/);
  assert.match(requests[0].body, /"app_secret":"secret_test"/);
  assert.equal(client.inspectTokenCache()?.token, "t_cached");
});

test("request 会自动补 Bearer token 并透传 JSON body", async () => {
  const requests = [];
  const client = createFeishuClient(
    { appId: "cli_test", appSecret: "secret_test" },
    {
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          method: init.method,
          headers: init.headers,
          body: init.body
        });

        if (requests.length === 1) {
          return createJsonResponse(200, {
            code: 0,
            msg: "ok",
            tenant_access_token: "t_request",
            expire: 7200
          });
        }

        return createJsonResponse(200, {
          code: 0,
          msg: "ok",
          data: {
            items: [{ token: "fldcn_root" }]
          }
        });
      }
    }
  );

  const response = await client.request("drive/v1/files", {
    method: "POST",
    body: {
      page_size: 1
    },
    searchParams: {
      folder_token: "fldcn_root"
    }
  });

  assert.equal(response.data.items[0].token, "fldcn_root");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].method, "POST");
  assert.equal(
    requests[1].headers.Authorization,
    "Bearer t_request"
  );
  assert.equal(
    requests[1].url,
    "https://open.feishu.cn/open-apis/drive/v1/files?folder_token=fldcn_root"
  );
  assert.match(requests[1].body, /"page_size":1/);
});

test("token 接口 HTTP 失败时会抛出带状态码的 FeishuApiError", async () => {
  const client = createFeishuClient(
    { appId: "cli_test", appSecret: "secret_test" },
    {
      fetchImpl: async () =>
        createJsonResponse(401, {
          code: 99991663,
          msg: "tenant access token invalid"
        })
    }
  );

  await assert.rejects(
    () => client.getTenantAccessToken(),
    (error) => {
      assert.ok(error instanceof FeishuApiError);
      assert.equal(error.status, 401);
      assert.match(error.message, /HTTP 请求失败/);
      assert.match(error.message, /status=401/);
      return true;
    }
  );
});

test("飞书业务错误会保留 code 与上下文", async () => {
  const client = createFeishuClient(
    { appId: "cli_test", appSecret: "secret_test" },
    {
      fetchImpl: async (url) => {
        if (String(url).includes("tenant_access_token")) {
          return createJsonResponse(200, {
            code: 0,
            msg: "ok",
            tenant_access_token: "t_request",
            expire: 7200
          });
        }

        return createJsonResponse(200, {
          code: 91403,
          msg: "no permission"
        });
      }
    }
  );

  await assert.rejects(
    () =>
      client.request("drive/v1/files", {
        searchParams: {
          folder_token: "fldcn_root"
        },
        context: {
          folder_token: "fldcn_root"
        }
      }),
    (error) => {
      assert.ok(error instanceof FeishuApiError);
      assert.equal(error.code, 91403);
      assert.match(error.message, /folder_token=fldcn_root/);
      assert.match(error.message, /code=91403/);
      return true;
    }
  );
});

test("响应缺少 token 字段时会立即失败", async () => {
  const client = createFeishuClient(
    { appId: "cli_test", appSecret: "secret_test" },
    {
      fetchImpl: async () =>
        createJsonResponse(200, {
          code: 0,
          msg: "ok",
          expire: 7200
        })
    }
  );

  await assert.rejects(
    () => client.getTenantAccessToken(),
    /tenant_access_token 响应缺少必要字段/
  );
});

test("user_access_token 模式会直接使用用户 token 发起请求", async () => {
  const requests = [];
  const client = createFeishuClient(
    {
      tokenMode: "user",
      userAccessToken: "u_static"
    },
    {
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          method: init.method,
          headers: init.headers,
          body: init.body
        });

        return createJsonResponse(200, {
          code: 0,
          msg: "ok",
          data: {
            files: [{ token: "dox_user" }]
          }
        });
      }
    }
  );

  const response = await client.request("drive/v1/files", {
    searchParams: {
      folder_token: "fldcn_user"
    }
  });

  assert.equal(response.data.files[0].token, "dox_user");
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].headers.Authorization,
    "Bearer u_static"
  );
  assert.equal(
    requests[0].url,
    "https://open.feishu.cn/open-apis/drive/v1/files?folder_token=fldcn_user"
  );
});

test("user_access_token 过期后会使用 refresh_token 刷新", async () => {
  const requests = [];
  const updatedTokens = [];
  const client = createFeishuClient(
    {
      appId: "cli_test",
      appSecret: "secret_test",
      tokenMode: "user",
      userAccessToken: "u_expired",
      userAccessTokenExpiresAt: 1,
      userRefreshToken: "ur_refresh"
    },
    {
      now: () => 10_000,
      onUserTokenUpdate(token) {
        updatedTokens.push(token);
      },
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          method: init.method,
          headers: init.headers,
          body: init.body
        });

        if (String(url).includes("app_access_token/internal")) {
          return createJsonResponse(200, {
            code: 0,
            msg: "ok",
            app_access_token: "a_refresh",
            expire: 7200
          });
        }

        if (String(url).includes("authen/v1/refresh_access_token")) {
          return createJsonResponse(200, {
            code: 0,
            msg: "ok",
            data: {
              access_token: "u_fresh",
              refresh_token: "ur_fresh",
              expires_in: 6900,
              refresh_expires_in: 2592000
            }
          });
        }

        return createJsonResponse(200, {
          code: 0,
          msg: "ok",
          data: {
            files: [{ token: "dox_after_refresh" }]
          }
        });
      }
    }
  );

  const response = await client.request("drive/v1/files", {
    searchParams: {
      folder_token: "fldcn_refresh"
    }
  });

  assert.equal(response.data.files[0].token, "dox_after_refresh");
  assert.equal(requests.length, 3);
  assert.match(requests[1].body, /"grant_type":"refresh_token"/);
  assert.match(requests[1].body, /"refresh_token":"ur_refresh"/);
  assert.equal(
    requests[2].headers.Authorization,
    "Bearer u_fresh"
  );
  assert.equal(updatedTokens.length, 1);
  assert.equal(updatedTokens[0].userAccessToken, "u_fresh");
  assert.equal(updatedTokens[0].userRefreshToken, "ur_fresh");
});
