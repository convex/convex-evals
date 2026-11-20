import { rejects } from "node:assert/strict";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmptyProviderResponseError, Model } from "./models/modelCodegen";
import { resolveModelDefaults, SYSTEM_PROMPT } from "./models/index";
import { validateClientWebRun } from "./models/clientWebResearch";
import {
  ClientWebProviderError,
  ClientWebTimeoutError,
  modelRequestRetry,
} from "./models/clientWebLoop";
import { InfrastructureError } from "./convexBackend";
import {
  computeWebUsage,
  webUsageAverages,
} from "../evalScores/convex/webUsage";

let previous: Record<string, string | undefined>;
let fetchBefore: typeof fetch;
let dir: string;
const names = [
  "CLIENT_WEB_TOOLS",
  "DISABLE_CONVEX_REPORTING",
  "EXA_API_KEY",
  "EVALS_EXPERIMENT",
  "GITHUB_ACTIONS",
  "GITHUB_REF",
  "ENABLE_CLIENT_WEB_PRODUCTION",
];
beforeEach(() => {
  previous = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  Object.assign(process.env, {
    GITHUB_ACTIONS: "false",
    ENABLE_CLIENT_WEB_PRODUCTION: "false",
    CLIENT_WEB_TOOLS: "1",
    DISABLE_CONVEX_REPORTING: "1",
    EXA_API_KEY: "exa-test-secret",
    EVALS_EXPERIMENT: "no_guidelines_with_web",
  });
  fetchBefore = globalThis.fetch;
  dir = mkdtempSync(join(tmpdir(), "client-web-integration-"));
});
afterEach(() => {
  for (const n of names) {
    if (previous[n] === undefined) delete process.env[n];
    else process.env[n] = previous[n];
  }
  globalThis.fetch = fetchBefore;
  rmSync(dir, { recursive: true, force: true });
});
const answer =
  "# Files\n\n## convex/tasks.ts\n```typescript\nexport const complete = true;\n```";
test("real Model adapter parses files, preserves prompt/settings, and sums all paid turns and Exa costs", async () => {
  const bodies: Array<{
    messages: Record<string, unknown>[];
    max_tokens: number;
    plugins: unknown[];
  }> = [];
  globalThis.fetch = Object.assign(
    async (url: string | URL | Request, init?: RequestInit) => {
      const requestUrl =
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (requestUrl.includes("api.exa.ai"))
        return Response.json({
          requestId: "exa-1",
          results: [],
          costDollars: { total: 0.007 },
        });
      if (typeof init?.body !== "string")
        throw new Error("Expected JSON request");
      const body = JSON.parse(init.body) as (typeof bodies)[number];
      bodies.push(body);
      const turn = bodies.length;
      return Response.json({
        id: `gen-${turn}`,
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
          cost: 0.1,
        },
        choices: [
          {
            finish_reason: turn === 1 ? "tool_calls" : "stop",
            message:
              turn === 1
                ? {
                    role: "assistant",
                    content: null,
                    reasoning_details: [
                      { type: "reasoning.text", text: "context" },
                    ],
                    tool_calls: [
                      {
                        id: "s1",
                        type: "function",
                        function: {
                          name: "web_search",
                          arguments: '{"query":"Convex mutations"}',
                        },
                      },
                    ],
                  }
                : { role: "assistant", content: answer },
          },
        ],
      });
    },
    { preconnect: fetchBefore.preconnect },
  ) as typeof fetch;
  const result = await new Model(
    "or-test-secret",
    resolveModelDefaults("openai/gpt-5.6-luna"),
  ).generate("Implement tasks", {
    sessionId: "session",
    webTracePath: join(dir, "trace.jsonl"),
  });
  expect(result.files["convex/tasks.ts"]).toContain("export const complete");
  expect(bodies[0].messages[0].content).toBe(SYSTEM_PROMPT);
  expect(bodies[0].messages[1].content).toContain("Implement tasks");
  expect(bodies[0].max_tokens).toBe(16384);
  expect(bodies[0].plugins).toEqual([]);
  expect(bodies[1].messages[2].reasoning_details).toHaveLength(1);
  expect(result.usage?.inputTokens).toBe(20);
  expect(result.usage?.raw?.cost).toBeCloseTo(0.207);
  const averages = webUsageAverages(
    computeWebUsage([
      { status: { kind: "passed", durationMs: 1, usage: result.usage } },
    ]),
  );
  expect(averages.averageWebSearchesPerEval).toBe(1);
  expect(averages.averageWebSearchesEstimated).toBe(false);
  expect(averages.averageWebFetchesPerEval).toBe(0);
  expect(result.usage?.raw?.clientWeb).toMatchObject({
    searchAttempts: 1,
    fetchAttempts: 0,
    successfulCalls: 1,
    modelTurns: 2,
    generationIds: ["gen-1", "gen-2"],
  });
  const trace = readFileSync(join(dir, "trace.jsonl"), "utf8");
  expect(trace).not.toContain("exa-test-secret");
  expect(trace).not.toContain("or-test-secret");
});
test("opt-in refuses reporting and wrong experiment before generation", () => {
  process.env.DISABLE_CONVEX_REPORTING = "0";
  expect(() => validateClientWebRun("no_guidelines_with_web")).toThrow(
    "DISABLE_CONVEX_REPORTING=1",
  );
  process.env.DISABLE_CONVEX_REPORTING = "1";
  expect(() => validateClientWebRun("no_guidelines")).toThrow(
    "requires no_guidelines_with_web",
  );
});
test("production reporting requires main Actions and explicit rollout enablement", () => {
  process.env.DISABLE_CONVEX_REPORTING = "0";
  process.env.GITHUB_ACTIONS = "true";
  process.env.GITHUB_REF = "refs/heads/main";
  expect(() => validateClientWebRun("no_guidelines_with_web")).toThrow();
  process.env.ENABLE_CLIENT_WEB_PRODUCTION = "true";
  expect(() => validateClientWebRun("no_guidelines_with_web")).not.toThrow();
  process.env.GITHUB_REF = "refs/heads/codex/pilot";
  expect(() => validateClientWebRun("no_guidelines_with_web")).toThrow();
  process.env.GITHUB_REF = "refs/heads/main";
  process.env.GITHUB_ACTIONS = "false";
  expect(() => validateClientWebRun("no_guidelines_with_web")).toThrow();
});
test("server-side web fallback cannot publish into the reset experiment", () => {
  delete process.env.CLIENT_WEB_TOOLS;
  process.env.DISABLE_CONVEX_REPORTING = "0";
  expect(() => validateClientWebRun("no_guidelines_with_web")).toThrow(
    "Published web runs require CLIENT_WEB_TOOLS=1",
  );
  expect(() => validateClientWebRun("no_guidelines")).not.toThrow();
});
test("token cutoff is graded like baseline without executing partial calls", async () => {
  globalThis.fetch = Object.assign(
    async () =>
      Response.json({
        choices: [
          {
            finish_reason: "length",
            message: {
              role: "assistant",
              content: answer,
              tool_calls: [
                {
                  id: "partial",
                  type: "function",
                  function: { name: "web_search", arguments: '{"query":' },
                },
              ],
            },
          },
        ],
      }),
    { preconnect: fetchBefore.preconnect },
  ) as typeof fetch;
  const work = new Model(
    "key",
    resolveModelDefaults("openai/gpt-5.6-luna"),
  ).generate("task", {
    sessionId: "s",
    webTracePath: join(dir, "trace.jsonl"),
  });
  const result = await work;
  expect(result.files["convex/tasks.ts"]).toContain("complete");
  expect(result.usage?.raw?.clientWeb).toMatchObject({
    modelOutcome: "output_limit",
    searchAttempts: 0,
    requestedCalls: 1,
    rejectedCalls: 1,
  });
  expect(readFileSync(join(dir, "trace.jsonl"), "utf8")).toContain(
    "output_limit",
  );
});

// DeepSeek's 4096-token cap often runs out on reasoning before any text, which
// used to be graded as a failed eval here while the baseline paths retried it.
// A null-content stop used to abort the whole run.
test.each([
  ["length", ""],
  ["stop", ""],
  ["stop", null],
  ["stop", "  \n"],
  ["content_filter", null],
])(
  "an empty %s turn (content %p) before any web call is retried, like baseline",
  async (finishReason, content) => {
    globalThis.fetch = Object.assign(
      async () =>
        Response.json({
          id: "gen-empty",
          choices: [
            {
              finish_reason: finishReason,
              message: { role: "assistant", content },
            },
          ],
        }),
      { preconnect: fetchBefore.preconnect },
    ) as typeof fetch;
    const error = await new Model(
      "key",
      resolveModelDefaults("deepseek/deepseek-v4-pro"),
    )
      .generate("task", {
        sessionId: "s",
        webTracePath: join(dir, "trace.jsonl"),
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmptyProviderResponseError);
    expect(error).not.toBeInstanceOf(InfrastructureError);
    expect(error).toMatchObject({
      openRouterGenerationId: "gen-empty",
      noWebUsage: true,
    });
    expect(readFileSync(join(dir, "trace.jsonl"), "utf8")).toContain(
      "generation_discarded",
    );
  },
);

// After a search, a token-limit cutoff is the model's own result (graded, as
// on main), but a reply with no text and no calls is a provider failure: on
// main it aborted the whole run, and the baseline paths retry it.
test.each([
  ["length", "", "graded"],
  ["stop", "", "retried"],
  ["stop", null, "retried"],
  // An "error" finish is retried inside the loop now (see below).
])(
  "an empty %s turn (content %p) after a web search is %s",
  async (finishReason, content, expected) => {
    let turn = 0;
    globalThis.fetch = Object.assign(
      async (url: string | URL | Request) => {
        const requestUrl =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        if (requestUrl.includes("api.exa.ai"))
          return Response.json({
            requestId: "exa-1",
            results: [],
            costDollars: { total: 0.007 },
          });
        turn++;
        return Response.json({
          id: `gen-${turn}`,
          choices: [
            turn === 1
              ? {
                  finish_reason: "tool_calls",
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "s1",
                        type: "function",
                        function: {
                          name: "web_search",
                          arguments: '{"query":"Convex"}',
                        },
                      },
                    ],
                  },
                }
              : {
                  finish_reason: finishReason,
                  message: { role: "assistant", content },
                },
          ],
        });
      },
      { preconnect: fetchBefore.preconnect },
    ) as typeof fetch;
    const outcome = await new Model(
      "key",
      resolveModelDefaults("deepseek/deepseek-v4-pro"),
    )
      .generate("task", {
        sessionId: "s",
        webTracePath: join(dir, "trace.jsonl"),
      })
      .catch((e: unknown) => e);
    if (expected === "graded") {
      expect(outcome).not.toBeInstanceOf(Error);
      const result = outcome as Awaited<ReturnType<Model["generate"]>>;
      expect(result.files).toEqual({});
      expect(result.usage?.raw?.clientWeb).toMatchObject({
        modelOutcome: "output_limit",
        searchAttempts: 1,
      });
    } else {
      expect(outcome).toBeInstanceOf(EmptyProviderResponseError);
      // A search ran, so dropping this attempt does hide web usage.
      expect(outcome).toMatchObject({
        openRouterGenerationId: "gen-2",
        noWebUsage: false,
      });
    }
  },
);

test("zero tool use is observed while absent model cost remains unknown", async () => {
  globalThis.fetch = Object.assign(
    async () =>
      Response.json({
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: answer },
          },
        ],
      }),
    { preconnect: fetchBefore.preconnect },
  ) as typeof fetch;
  const result = await new Model(
    "key",
    resolveModelDefaults("openai/gpt-5.6-luna"),
  ).generate("task", {
    sessionId: "s",
    webTracePath: join(dir, "trace.jsonl"),
  });
  expect(result.usage?.raw?.cost).toBeUndefined();
  const averages = webUsageAverages(
    computeWebUsage([
      { status: { kind: "passed", durationMs: 1, usage: result.usage } },
    ]),
  );
  expect(averages.averageWebSearchesPerEval).toBe(0);
  expect(averages.averageWebSearchesEstimated).toBe(false);
  expect(result.usage?.raw?.clientWeb).toMatchObject({
    searchAttempts: 0,
    fetchAttempts: 0,
    exaCost: 0,
  });
  expect(readFileSync(join(dir, "trace.jsonl"), "utf8")).toContain(
    "generation_usage",
  );
});

test("model exhausting tool turns remains a scored failure with exact rejected counts", async () => {
  let turn = 0;
  globalThis.fetch = Object.assign(
    async () =>
      Response.json({
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
          cost: 0.01,
        },
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `call-${++turn}`,
                  type: "function",
                  function: { name: "unknown", arguments: "{}" },
                },
              ],
            },
          },
        ],
      }),
    { preconnect: fetchBefore.preconnect },
  ) as typeof fetch;
  const result = await new Model(
    "key",
    resolveModelDefaults("openai/gpt-5.6-luna"),
  ).generate("task", {
    sessionId: "s",
    webTracePath: join(dir, "trace.jsonl"),
  });
  expect(result.files).toEqual({});
  expect(result.usage?.raw?.clientWeb).toMatchObject({
    modelOutcome: "tool_budget_exhausted",
    requestedCalls: 7,
    rejectedCalls: 7,
    searchAttempts: 0,
    fetchAttempts: 0,
  });
});

test("a provider error the baseline does not retry aborts as infrastructure and redacts credentials", async () => {
  globalThis.fetch = Object.assign(
    async () => Response.json({ error: "or-test-secret" }, { status: 401 }),
    { preconnect: fetchBefore.preconnect },
  ) as typeof fetch;
  const promise = new Model(
    "or-test-secret",
    resolveModelDefaults("openai/gpt-5.6-luna"),
  ).generate("task", {
    sessionId: "s",
    webTracePath: join(dir, "trace.jsonl"),
  });
  await rejects(promise, InfrastructureError);
  await rejects(
    promise,
    (error) =>
      error instanceof Error && !error.message.includes("or-test-secret"),
  );
  expect(readFileSync(join(dir, "trace.jsonl"), "utf8")).not.toContain(
    "or-test-secret",
  );
});

// An OpenRouter 429 ("temporarily rate-limited upstream") threw out the GPT-6.2
// Sol and Astra web runs in Nov 2026 on the first try. Other runs wait and
// retry rate limits, 5xx errors and dropped connections, so web runs do too:
// first the one request inside the loop, then the whole eval in the runner.
const searchTurn = {
  id: "gen-1",
  choices: [
    {
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "s1",
            type: "function",
            function: { name: "web_search", arguments: '{"query":"Convex"}' },
          },
        ],
      },
    },
  ],
};
const failures: Record<string, () => Response> = {
  "HTTP 429": () =>
    Response.json(
      { error: { message: "temporarily rate-limited upstream", code: 429 } },
      { status: 429, headers: { "Retry-After": "0" } },
    ),
  "a 503 code in a 200 body": () =>
    Response.json({ error: { message: "upstream down", code: 503 } }),
  "a string 503 code in a 200 body": () =>
    Response.json({ error: { message: "upstream down", code: "503" } }),
  "an HTML 502 page from a proxy": () =>
    new Response("<html>Bad Gateway</html>", {
      status: 502,
      headers: { "Content-Type": "text/html" },
    }),
  "an empty 503 body": () => new Response("", { status: 503 }),
  "an error string in a 200 body": () =>
    Response.json({ error: "Upstream error" }),
  "a provider error on the choice": () =>
    Response.json({
      id: "gen-x",
      choices: [
        {
          finish_reason: "error",
          error: { code: 503, message: "Provider disconnected" },
          message: { role: "assistant", content: "" },
        },
      ],
    }),
  "an error finish with no detail": () =>
    Response.json({
      id: "gen-x",
      choices: [
        {
          finish_reason: "error",
          message: { role: "assistant", content: null },
        },
      ],
    }),
  "a dropped connection": () => {
    throw new TypeError("fetch failed");
  },
};
const expectedStatus: Record<string, number> = {
  "HTTP 429": 429,
  "a 503 code in a 200 body": 503,
  "a string 503 code in a 200 body": 503,
  "an HTML 502 page from a proxy": 502,
  "an empty 503 body": 503,
  "an error string in a 200 body": 502,
  "a provider error on the choice": 503,
  "an error finish with no detail": 502,
  "a dropped connection": 0,
};
function fakeOpenRouter(modelResponses: (() => Response)[]) {
  const calls = { model: 0, exa: 0 };
  globalThis.fetch = Object.assign(
    async (url: string | URL | Request) => {
      const requestUrl =
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (requestUrl.includes("api.exa.ai")) {
        calls.exa++;
        return Response.json({
          requestId: "exa-1",
          results: [],
          costDollars: { total: 0.007 },
        });
      }
      const next =
        modelResponses[Math.min(calls.model, modelResponses.length - 1)];
      calls.model++;
      return next();
    },
    { preconnect: fetchBefore.preconnect },
  ) as typeof fetch;
  return calls;
}
const generate = () =>
  new Model(
    "or-test-secret",
    resolveModelDefaults("openai/gpt-5.6-luna"),
  ).generate("task", {
    sessionId: "s",
    webTracePath: join(dir, "trace.jsonl"),
  });
const realRetry = { ...modelRequestRetry };
beforeEach(() => Object.assign(modelRequestRetry, { baseMs: 1, maxWaitMs: 5 }));
afterEach(() => Object.assign(modelRequestRetry, realRetry));

test.each(Object.keys(failures))(
  "%s is retried inside the loop and keeps the search already made",
  async (kind) => {
    const calls = fakeOpenRouter([
      () => Response.json(searchTurn),
      failures[kind],
      failures[kind],
      () =>
        Response.json({
          id: "gen-2",
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: answer },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
    ]);
    const result = await generate();
    expect(result.files["convex/tasks.ts"]).toContain("complete");
    expect(calls).toEqual({ model: 4, exa: 1 });
    expect(result.usage?.raw).toMatchObject({
      webResearch: { searchRequests: 1 },
    });
    const trace = readFileSync(join(dir, "trace.jsonl"), "utf8");
    expect(trace.match(/"model_request_retry"/g)).toHaveLength(2);
    expect(trace).toContain(`"status":${expectedStatus[kind]}`);
  },
);

test.each([
  ["before any web call", false, true],
  ["after a web search", true, false],
])(
  "a 429 that outlasts the loop's retries %s is left to the runner to retry",
  async (_label, searchFirst, noWebUsage) => {
    const calls = fakeOpenRouter(
      searchFirst
        ? [() => Response.json(searchTurn), failures["HTTP 429"]]
        : [failures["HTTP 429"]],
    );
    const error = await generate().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClientWebProviderError);
    expect(error).not.toBeInstanceOf(InfrastructureError);
    expect(error).toMatchObject({ status: 429, noWebUsage });
    expect(calls.model).toBe(
      modelRequestRetry.retries + 1 + (searchFirst ? 1 : 0),
    );
    expect((error as Error).message).toContain("(429)");
    expect((error as Error).message).toContain(join(dir, "trace.jsonl"));
    expect((error as Error).message).not.toContain("ClientWebProviderError");
  },
);

test("a failed response's billed usage is kept", async () => {
  fakeOpenRouter([
    () =>
      Response.json({
        id: "gen-x",
        choices: [
          {
            finish_reason: "error",
            message: { role: "assistant", content: "" },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }),
    () =>
      Response.json({
        id: "gen-2",
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: answer },
          },
        ],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      }),
  ]);
  const result = await generate();
  expect(result.usage).toMatchObject({
    inputTokens: 12,
    outputTokens: 5,
    totalTokens: 17,
  });
});

test("an answer that finished normally is graded even with an error field", async () => {
  const calls = fakeOpenRouter([
    () =>
      Response.json({
        id: "gen-1",
        choices: [
          {
            finish_reason: "stop",
            error: null,
            message: { role: "assistant", content: answer },
          },
        ],
      }),
  ]);
  const result = await generate();
  expect(result.files["convex/tasks.ts"]).toContain("complete");
  expect(calls.model).toBe(1);
});

test("a 401 is not retried", async () => {
  const calls = fakeOpenRouter([
    () => Response.json({ error: { code: 401 } }, { status: 401 }),
  ]);
  await rejects(generate(), InfrastructureError);
  expect(calls.model).toBe(1);
});

test("Retry-After below the cap sets the wait", async () => {
  fakeOpenRouter([
    () =>
      Response.json(
        { error: { code: 429 } },
        { status: 429, headers: { "Retry-After": "0.003" } },
      ),
    () =>
      Response.json({
        id: "gen-2",
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: answer },
          },
        ],
      }),
  ]);
  await generate();
  expect(readFileSync(join(dir, "trace.jsonl"), "utf8")).toContain(
    '"waitMs":3',
  );
});

test("Retry-After sets the wait, up to the cap", async () => {
  fakeOpenRouter([
    () =>
      Response.json(
        { error: { code: 429 } },
        { status: 429, headers: { "Retry-After": "120" } },
      ),
    () =>
      Response.json({
        id: "gen-2",
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: answer },
          },
        ],
      }),
  ]);
  await generate();
  const trace = readFileSync(join(dir, "trace.jsonl"), "utf8");
  expect(trace).toContain(`"waitMs":${modelRequestRetry.maxWaitMs}`);
});

// A model that hadn't answered when the five-minute loop limit ran out used to
// abort the whole run (11 of 40 web runs in Nov 2026). The baseline retries
// timeouts, so this is now a retryable error, not an InfrastructureError.
test.each([
  ["before any web call", "none", true],
  ["after a web search", "search", false],
  // The cut-off call may have run at Exa, so it counts as web usage.
  ["during a web search", "hangingSearch", false],
])(
  "a loop timeout %s is retryable",
  async (_label, searchFirst, noWebUsage) => {
    const loopLimit = new AbortController();
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = (ms: number) =>
      ms === 300_000 ? loopLimit.signal : realTimeout(ms);
    let turn = 0;
    globalThis.fetch = Object.assign(
      async (url: string | URL | Request, init?: RequestInit) => {
        const requestUrl =
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        // A slow request hangs until the loop limit fires. Check aborted
        // first: a listener added after the abort would never run.
        const hang = () => {
          const signal = init?.signal;
          if (!signal) throw new Error("Expected the loop's abort signal");
          setTimeout(
            () =>
              loopLimit.abort(
                new DOMException("The operation timed out.", "TimeoutError"),
              ),
            5,
          );
          return new Promise<Response>((_, reject) => {
            if (signal.aborted) reject(signal.reason as Error);
            signal.addEventListener("abort", () =>
              reject(signal.reason as Error),
            );
          });
        };
        if (requestUrl.includes("api.exa.ai"))
          return searchFirst === "hangingSearch"
            ? await hang()
            : Response.json({
                requestId: "exa-1",
                results: [],
                costDollars: { total: 0.007 },
              });
        turn++;
        if (searchFirst !== "none" && turn === 1)
          return Response.json({
            id: "gen-1",
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "s1",
                      type: "function",
                      function: {
                        name: "web_search",
                        arguments: '{"query":"Convex"}',
                      },
                    },
                  ],
                },
              },
            ],
          });
        return await hang();
      },
      { preconnect: fetchBefore.preconnect },
    ) as typeof fetch;
    try {
      const error = await new Model(
        "or-test-secret",
        resolveModelDefaults("deepseek/deepseek-v4-pro"),
      )
        .generate("task", {
          sessionId: "s",
          webTracePath: join(dir, "trace.jsonl"),
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ClientWebTimeoutError);
      expect(error).not.toBeInstanceOf(InfrastructureError);
      expect(error).toMatchObject({ noWebUsage });
      expect((error as Error).message).toContain("timed out");
      expect((error as Error).message).toContain(join(dir, "trace.jsonl"));
      expect((error as Error).message).not.toContain("ClientWebTimeoutError");
      const trace = readFileSync(join(dir, "trace.jsonl"), "utf8");
      expect(trace).toContain("Web loop timed out after 300s");
      expect(trace).not.toContain("or-test-secret");
    } finally {
      AbortSignal.timeout = realTimeout;
    }
  },
);
