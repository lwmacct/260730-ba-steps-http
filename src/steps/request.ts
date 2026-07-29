/**
 * 步骤用途：
 * 向 input.baseUrl 指定的任意 HTTP(S) API 发起 JSON/text 请求并返回响应事实；
 * 不识别页面状态，不依赖页面 URL，也不包含任何具体服务或账号领域逻辑。
 */
import type { JsonValue } from "@lwmacct/260729-ba-context-baton";
import {
  defineStep,
  jsonInput,
  objectInput,
  output,
  stepResult,
  stringInput,
} from "@lwmacct/260729-ba-framework/step";
import type {
  StepDefinition,
  StepRunResult,
} from "@lwmacct/260729-ba-framework/step";

const STEP_NAME = "http/request";
const METHODS_WITHOUT_BODY = new Set(["GET", "HEAD"]);
const SUPPORTED_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

const step: StepDefinition<typeof STEP_NAME, HttpRequestInput> = defineStep({
  id: STEP_NAME,
  type: "action",
  title: "HTTP 请求",
  description: "向任意 HTTP(S) API 发起请求并返回 JSON 或文本响应。",
  tags: ["http", "api"],
  inputs: {
    baseUrl: stringInput<true>({
      label: "Base URL",
      required: true,
      ui: { inputMode: "url" },
    }),
    path: stringInput({
      label: "Path",
      description: "追加到 Base URL 路径后的相对路径。",
    }),
    method: stringInput({
      label: "Method",
      defaultValue: "GET",
    }),
    authorization: stringInput({
      label: "Authorization",
      description: "完整 Authorization header 值。",
    }),
    headers: objectInput({
      label: "Headers",
      description: "值必须全部为字符串的请求 header 对象。",
      ui: { inputMode: "textarea" },
    }),
    query: objectInput({
      label: "Query",
      description: "标量或标量数组组成的查询参数对象。",
      ui: { inputMode: "textarea" },
    }),
    body: jsonInput({
      label: "Body",
      description: "可选的任意 JSON 请求体。",
      ui: { inputMode: "textarea" },
    }),
  },
  outputs: {
    url: output({ label: "最终 URL", valueType: "string", valueFormat: "url" }),
    status: output({ label: "HTTP 状态码", valueType: "number" }),
    ok: output({ label: "请求成功", valueType: "boolean" }),
    headers: output({ label: "响应 Headers", valueType: "object" }),
    body: output({ label: "响应 Body", valueType: "unknown" }),
  },
  run: ({ input, signal }) => runStep(input, signal),
});

export default step;

type HttpRequestInput = {
  authorization?: string;
  baseUrl: string;
  body?: JsonValue;
  headers?: Record<string, unknown>;
  method?: string;
  path?: string;
  query?: Record<string, unknown>;
};

type HttpResponseOutputs = {
  body: JsonValue | null;
  headers: Record<string, string>;
  ok: boolean;
  status: number;
  url: string;
};

type QueryScalar = boolean | null | number | string;

class HttpStepError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

function failedResult(
  error: HttpStepError,
  outputs: Partial<HttpResponseOutputs> = {},
): StepRunResult {
  return stepResult(outputs, {
    status: "failed",
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    },
  });
}

function requestMethod(value?: string) {
  const method = (value ?? "GET").toUpperCase();
  if (!SUPPORTED_METHODS.has(method)) {
    throw new HttpStepError(
      "http-method-not-supported",
      `HTTP method is not supported: ${method}.`,
      false,
    );
  }
  return method;
}

function requestUrl(input: HttpRequestInput) {
  let url: URL;
  try {
    url = new URL(input.baseUrl);
  } catch {
    throw new HttpStepError(
      "http-invalid-url",
      "Base URL must be an absolute HTTP(S) URL.",
      false,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpStepError(
      "http-invalid-url",
      "Base URL must use HTTP or HTTPS.",
      false,
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new HttpStepError(
      "http-invalid-url",
      "Base URL cannot contain credentials, query parameters, or a fragment.",
      false,
    );
  }

  if (input.path !== undefined) {
    if (input.path.includes("?") || input.path.includes("#")) {
      throw new HttpStepError(
        "http-invalid-url",
        "Path cannot contain query parameters or a fragment.",
        false,
      );
    }
    const basePath = url.pathname.replace(/\/+$/, "");
    const relativePath = input.path.replace(/^\/+/, "");
    url.pathname = `${basePath}/${relativePath}` || "/";
  }
  appendQuery(url, input.query);
  return url;
}

function appendQuery(url: URL, query?: Record<string, unknown>) {
  for (const [name, value] of Object.entries(query ?? {})) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (!isQueryScalar(item)) {
        throw new HttpStepError(
          "http-invalid-query",
          `Query parameter must be a scalar or scalar array: ${name}.`,
          false,
        );
      }
      url.searchParams.append(name, item === null ? "" : String(item));
    }
  }
}

function isQueryScalar(value: unknown): value is QueryScalar {
  return value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value));
}

function requestHeaders(input: HttpRequestInput) {
  const headers = new Headers();
  try {
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      if (typeof value !== "string") {
        throw new Error("header value must be a string");
      }
      headers.set(name, value);
    }
    if (input.authorization !== undefined) {
      headers.set("Authorization", input.authorization);
    }
  } catch {
    throw new HttpStepError(
      "http-invalid-headers",
      "Request headers must have valid names and string values.",
      false,
    );
  }
  return headers;
}

function responseHeaders(response: Response) {
  return Object.fromEntries(response.headers.entries());
}

function isJsonContentType(value: string | null) {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || Boolean(mediaType?.endsWith("+json"));
}

function isFiniteJson(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isFiniteJson);
  return Boolean(value) &&
    typeof value === "object" &&
    Object.values(value).every(isFiniteJson);
}

function parseResponseBody(response: Response, text: string) {
  if (!text) return { body: null, invalidJson: false } as const;
  if (!isJsonContentType(response.headers.get("content-type"))) {
    return { body: text, invalidJson: false } as const;
  }
  try {
    const body = JSON.parse(text) as unknown;
    return isFiniteJson(body)
      ? { body, invalidJson: false } as const
      : { body: text, invalidJson: true } as const;
  } catch {
    return { body: text, invalidJson: true } as const;
  }
}

function responseError(status: number) {
  if (status >= 400 && status < 500) {
    return new HttpStepError(
      "http-client-error",
      `HTTP request returned client error ${status}.`,
      status === 408 || status === 429,
    );
  }
  if (status >= 500) {
    return new HttpStepError(
      "http-server-error",
      `HTTP request returned server error ${status}.`,
      true,
    );
  }
  return new HttpStepError(
    "http-unexpected-status",
    `HTTP request returned unexpected status ${status}.`,
    false,
  );
}

async function runStep(
  input: HttpRequestInput,
  signal: AbortSignal,
): Promise<StepRunResult> {
  let method: string;
  let url: URL;
  let headers: Headers;
  try {
    method = requestMethod(input.method);
    url = requestUrl(input);
    headers = requestHeaders(input);
    if (input.body !== undefined && METHODS_WITHOUT_BODY.has(method)) {
      throw new HttpStepError(
        "http-body-not-supported",
        `${method} requests cannot include a body.`,
        false,
      );
    }
  } catch (error) {
    return failedResult(error as HttpStepError);
  }

  const hasBody = input.body !== undefined;
  if (hasBody && !headers.has("content-type")) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: hasBody ? JSON.stringify(input.body) : undefined,
      redirect: "follow",
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    return failedResult(new HttpStepError(
      "http-network-error",
      "HTTP request failed before a response was received.",
      true,
    ));
  }

  const baseOutputs = {
    body: null,
    headers: responseHeaders(response),
    ok: response.ok,
    status: response.status,
    url: response.url || url.toString(),
  } satisfies HttpResponseOutputs;
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (signal.aborted) throw error;
    return failedResult(new HttpStepError(
      "http-network-error",
      "HTTP response body could not be read.",
      true,
    ), baseOutputs);
  }

  const parsed = parseResponseBody(response, text);
  const outputs = { ...baseOutputs, body: parsed.body } satisfies HttpResponseOutputs;
  if (!response.ok) return failedResult(responseError(response.status), outputs);
  if (parsed.invalidJson) {
    return failedResult(new HttpStepError(
      "http-invalid-json",
      "HTTP response declared JSON but did not contain a finite JSON value.",
      false,
    ), outputs);
  }
  return stepResult(outputs);
}
