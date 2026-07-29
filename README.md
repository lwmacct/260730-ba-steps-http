# BA HTTP Steps

`BA` 是 Browser Automation（浏览器自动化）的缩写。

`@lwmacct/260730-ba-steps-http` 是一个可信任的通用 HTTP Step Pack。它通过 Step input
接收目标地址、Authorization、headers、query 和 JSON body，并返回有限 JSON/text
响应事实。本包不拥有任何具体服务、账号或业务数据模型。

## 安装

```bash
pnpm add @lwmacct/260730-ba-steps-http
```

默认导出 Pack：

```text
Pack: http/core
Step: http/request
```

Executor 可以把默认导出作为普通可加载 Step Pack 注册。

## 本地运行

本仓库可通过开发依赖中的 BA Executor 直接加载包根目录：

```bash
pnpm run start
pnpm run start -- --port 3001
pnpm run dev
pnpm run dev -- --port 3001
```

`start` 构建一次并启动 HTTP Host；`dev` 监听源码，在构建成功后自动重启 Host。Executor
仅用于本仓库的本地运行和验证，不会打入发布的 Pack。

也可以从命令行执行本地 Baton：

```bash
pnpm run cli -- --context ./local.json --entry example-entry --mode single
```

`single` 只执行指定 entry，`continue` 会继续执行后续计划。CLI 会原子写回 Baton 文件；
包含 Authorization、目标地址或执行结果的本地文件不应提交。

## `http/request`

输入：

- `baseUrl`：必填的绝对 HTTP(S) URL，可包含基础路径，但不能包含 credentials、query
  或 fragment。
- `path`：追加到基础路径的相对路径；开头的 `/` 不会覆盖基础路径。
- `method`：`GET`、`HEAD`、`POST`、`PUT`、`PATCH`、`DELETE` 或 `OPTIONS`，默认
  `GET`。
- `authorization`：可选的完整 Authorization header 值，不自动添加 `Bearer`。
- `headers`：可选的字符串 header 对象。`authorization` 输入优先于其中的
  `Authorization`。
- `query`：可选的标量或标量数组对象。数组生成重复参数，`null` 生成空值。
- `body`：可选的任意有限 JSON 值。有 body 且未指定 Content-Type 时自动使用
  `application/json`；GET 和 HEAD 不接受 body。

输出：

```ts
{
  url: string
  status: number
  ok: boolean
  headers: Record<string, string>
  body: JsonValue | null
}
```

空响应的 `body` 为 `null`。JSON 和 `+json` Content-Type 会被解析为 JSON，其他
响应作为字符串返回。非 2xx 响应返回 `failed`，但仍保留响应 URL、status、headers
和 body。408、429、网络错误及 5xx 标记为可重试；本 Step 不自行执行重试。

稳定错误码：

```text
http-invalid-url
http-method-not-supported
http-body-not-supported
http-invalid-headers
http-invalid-query
http-network-error
http-invalid-json
http-client-error
http-server-error
http-unexpected-status
```

## 信任边界

本 Pack 不执行主机白名单或私网地址拦截。Workflow 与 Step 必须在可信任边界内运行，
Executor 的网络权限就是请求权限。Authorization 只作为请求 header 使用，不会复制到
Step output 或错误信息中。

## 验证

```bash
pnpm install
pnpm check
pnpm pack --pack-destination /tmp
```
