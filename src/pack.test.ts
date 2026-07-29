import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import pack from "./index.js";

const definition = pack.steps[0];

test("exports the HTTP Step Pack", () => {
  assert.equal(pack.kind, "step-pack");
  assert.equal(pack.version, 1);
  assert.equal(pack.id, "http/core");
  assert.deepEqual(pack.steps.map((step) => step.id), ["http/request"]);
  assert.equal(
    definition?.inputHints.find((input) => input.name === "body")?.valueType,
    "unknown",
  );
});

test("sends query parameters and an exact Authorization value", async () => {
  await withServer(async (request, response) => {
    assert.equal(request.url, "/api/records?active=true&empty=&tag=one&tag=two");
    assert.equal(request.headers.authorization, "Token exact-secret");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("X-Result", "ok");
    response.end(JSON.stringify({ records: [1, 2] }));
  }, async (baseUrl) => {
    const result = await run({
      authorization: "Token exact-secret",
      baseUrl: `${baseUrl}/api/`,
      headers: { Authorization: "Bearer replaced" },
      path: "/records",
      query: { active: true, empty: null, tag: ["one", "two"] },
    });

    assert.equal(result.status, "succeeded");
    assert.equal(result.outputs.status, 200);
    assert.equal(result.outputs.ok, true);
    assert.deepEqual(result.outputs.body, { records: [1, 2] });
    assert.equal(
      (result.outputs.headers as Record<string, string>)["x-result"],
      "ok",
    );
    assert.equal(JSON.stringify(result).includes("exact-secret"), false);
  });
});

test("sends JSON bodies and preserves caller headers", async () => {
  await withServer(async (request, response) => {
    assert.equal(request.method, "PATCH");
    assert.equal(request.url, "/items/42");
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.headers["x-request-id"], "request-1");
    assert.deepEqual(JSON.parse(await readRequestBody(request)), {
      enabled: true,
      tags: ["a", "b"],
    });
    response.setHeader("Content-Type", "application/json");
    response.end("null");
  }, async (baseUrl) => {
    const result = await run({
      baseUrl,
      body: { enabled: true, tags: ["a", "b"] },
      headers: { "X-Request-Id": "request-1" },
      method: "patch",
      path: "items/42",
    });
    assert.equal(result.status, "succeeded");
    assert.equal(result.outputs.body, null);
  });
});

test("returns null for empty responses and strings for non-JSON responses", async () => {
  let requestCount = 0;
  await withServer((_request, response) => {
    requestCount += 1;
    if (requestCount === 1) {
      response.writeHead(204).end();
      return;
    }
    response.setHeader("Content-Type", "text/plain");
    response.end("plain response");
  }, async (baseUrl) => {
    const empty = await run({ baseUrl, path: "empty" });
    const text = await run({ baseUrl, path: "text" });
    assert.equal(empty.outputs.body, null);
    assert.equal(text.outputs.body, "plain response");
  });
});

test("classifies HTTP status failures without discarding response facts", async () => {
  for (const [status, code, retryable] of [
    [400, "http-client-error", false],
    [429, "http-client-error", true],
    [503, "http-server-error", true],
  ] as const) {
    await withServer((_request, response) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status }));
    }, async (baseUrl) => {
      const result = await run({ baseUrl });
      assert.equal(result.status, "failed");
      assert.equal(result.error?.code, code);
      assert.equal(result.error?.retryable, retryable);
      assert.equal(result.outputs.status, status);
      assert.deepEqual(result.outputs.body, { status });
    });
  }
});

test("reports malformed declared JSON without hiding the raw response", async () => {
  await withServer((_request, response) => {
    response.setHeader("Content-Type", "application/problem+json");
    response.end("{invalid");
  }, async (baseUrl) => {
    const result = await run({ baseUrl });
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "http-invalid-json");
    assert.equal(result.error?.retryable, false);
    assert.equal(result.outputs.body, "{invalid");
  });
});

test("returns stable failures for invalid request contracts", async () => {
  for (const [input, code] of [
    [{ baseUrl: "file:///tmp/data" }, "http-invalid-url"],
    [{ baseUrl: "http://example.test", method: "TRACE" }, "http-method-not-supported"],
    [{ baseUrl: "http://example.test", body: null }, "http-body-not-supported"],
    [{ baseUrl: "http://example.test", query: { nested: { no: true } } }, "http-invalid-query"],
    [{ baseUrl: "http://example.test", headers: { invalid: 1 } }, "http-invalid-headers"],
  ] as const) {
    const result = await run(input);
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, code);
    assert.equal(result.error?.retryable, false);
    assert.deepEqual(result.outputs, {});
  }
});

test("marks connection failures as retryable", async () => {
  const server = http.createServer();
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  await close(server);

  const result = await run({ baseUrl });
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "http-network-error");
  assert.equal(result.error?.retryable, true);
});

test("forwards aborts to fetch and lets the Executor own cancellation", async () => {
  await withServer((_request, _response) => undefined, async (baseUrl) => {
    const controller = new AbortController();
    const result = run({ baseUrl }, controller.signal);
    controller.abort();
    await assert.rejects(result, (error: unknown) => {
      assert.equal((error as Error).name, "AbortError");
      return true;
    });
  });
});

async function run(input: Record<string, unknown>, signal?: AbortSignal) {
  assert.ok(definition);
  return definition.run({
    input: definition.normalizeInput(input, "step.http/request.input"),
    resources: {},
    signal: signal ?? new AbortController().signal,
  });
}

async function withServer(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void | Promise<void>,
  runTest: (baseUrl: string) => Promise<void>,
) {
  const server = http.createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error) => {
      response.destroy(error as Error);
    });
  });
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await runTest(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await close(server);
  }
}

function listen(server: http.Server) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: http.Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function readRequestBody(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
