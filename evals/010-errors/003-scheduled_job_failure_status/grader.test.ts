import { beforeEach, expect, test } from "vitest";
import {
  compareFunctionSpec,
  compareSchema,
  deleteAllDocuments,
  pollUntil,
  responseAdminClient,
  responseClient,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { Id } from "./answer/convex/_generated/dataModel";

type ImportStatus = {
  source: string;
  status: "pending" | "succeeded" | "failed";
  error: string | null;
};

function start(source: string): Promise<Id<"imports">> {
  return responseClient.mutation(api.index.startImport, { source });
}

async function getImport(importId: Id<"imports">): Promise<ImportStatus | null> {
  return (await responseClient.query(api.index.getImport, {
    importId,
  })) as ImportStatus | null;
}

// Polls until the import is no longer pending, returning every status seen.
async function waitUntilFinished(
  importId: Id<"imports">,
): Promise<{ final: ImportStatus; seen: string[] }> {
  const seen: string[] = [];
  let latest: ImportStatus | null = null;
  await pollUntil(
    async () => {
      latest = await getImport(importId);
      seen.push(latest?.status ?? "null");
      return latest !== null && latest.status !== "pending";
    },
    { timeoutMs: 15_000, intervalMs: 100 },
  );
  return { final: latest!, seen };
}

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["imports"]);
});

test("compare schema", async ({ skip }) => {
  // No status fields or tables may be added: the scheduler's record is the
  // only source of an import's progress.
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  // The given worker and both public functions must match; extra internal
  // helpers are fine.
  await compareFunctionSpec(skip, {
    ignoreReturns: true,
    allowAdditionalFunctions: true,
  });
});

test("only startImport and getImport are public", async ({ skip }) => {
  await compareFunctionSpec(skip, { ignoreReturns: true, publicOnly: true });
});

test("a successful import is reported as succeeded", { timeout: 20_000 }, async () => {
  const importId = await start("customers.csv");

  const { final } = await waitUntilFinished(importId);

  expect(final).toEqual({
    source: "customers.csv",
    status: "succeeded",
    error: null,
  });
});

test(
  "a failed import is reported as failed with the error Convex recorded",
  { timeout: 20_000 },
  async () => {
    const importId = await start("orders.broken");

    const { final } = await waitUntilFinished(importId);

    expect(final.source).toBe("orders.broken");
    expect(final.status).toBe("failed");
    // Convex records the thrown error with its own prefix and a stack trace
    // through the worker, which made-up text wouldn't have.
    expect(final.error).toMatch(/^Uncaught Error: Cannot parse orders\.broken\b/);
    expect(final.error).toMatch(/importWorker/);
  },
);

test("an import stays pending while the worker runs", { timeout: 20_000 }, async () => {
  const importId = await start("slow:archive.csv");

  expect(await getImport(importId)).toEqual({
    source: "slow:archive.csv",
    status: "pending",
    error: null,
  });
  // The worker sleeps for 3 seconds, so most polls land while it is running.
  const { final, seen } = await waitUntilFinished(importId);

  expect(new Set(seen.slice(0, -1))).toEqual(new Set(["pending"]));
  expect(final).toEqual({
    source: "slow:archive.csv",
    status: "succeeded",
    error: null,
  });
});

test("a failed run can fail slowly too", { timeout: 20_000 }, async () => {
  const importId = await start("slow:legacy.broken");

  const { final, seen } = await waitUntilFinished(importId);

  expect(new Set(seen.slice(0, -1))).toEqual(new Set(["pending"]));
  expect(final.status).toBe("failed");
  expect(final.error).toMatch(/^Uncaught Error: Cannot parse slow:legacy\.broken\b/);
  expect(final.error).toMatch(/importWorker/);
});

test("each import reports its own outcome", { timeout: 20_000 }, async () => {
  const good = await start("good.csv");
  const bad = await start("bad.broken");

  const goodResult = (await waitUntilFinished(good)).final;
  const badResult = (await waitUntilFinished(bad)).final;

  expect(goodResult).toEqual({ source: "good.csv", status: "succeeded", error: null });
  expect(badResult.status).toBe("failed");
  expect(badResult.error).toMatch(/^Uncaught Error: Cannot parse bad\.broken\b/);
});

test("getImport returns null for an import that does not exist", async () => {
  const importId = await start("gone.csv");
  await deleteAllDocuments(responseAdminClient, ["imports"]);

  expect(await getImport(importId)).toBeNull();
});
