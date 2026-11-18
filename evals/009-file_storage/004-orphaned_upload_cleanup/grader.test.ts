import { beforeEach, expect, test } from "vitest";
import { anyApi } from "convex/server";
import {
  addDocuments,
  compareFunctionSpec,
  compareSchema,
  deleteAllDocuments,
  deleteAllStoredFiles,
  deleteStoredFiles,
  generateAdminUploadUrl,
  listStoredFiles,
  responseAdminClient,
  responseClient,
  uploadFile,
  type StoredFile,
} from "../../../grader";
import { internal } from "./answer/convex/_generated/api";

// Files are uploaded the way the browser does it, straight to storage, with
// nothing in the app recording the upload.
async function upload(label: string): Promise<string> {
  const uploadUrl = await generateAdminUploadUrl(responseAdminClient);
  return await uploadFile(uploadUrl, label, "text/plain");
}

// Uploads many files, a batch at a time.
async function uploadMany(labels: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < labels.length; i += 25) {
    ids.push(...(await Promise.all(labels.slice(i, i + 25).map(upload))));
  }
  return ids;
}

async function reference(fileId: string, title: string) {
  await addDocuments(responseAdminClient, "documents", [{ title, fileId }]);
}

async function stored(): Promise<Map<string, StoredFile>> {
  return new Map(
    (await listStoredFiles(responseAdminClient)).map((file) => [file._id, file]),
  );
}

async function cleanup(uploadedBefore: number): Promise<number> {
  // The admin client may call internal functions; its types only allow
  // public references, as in the other graders that do this.
  return (await responseAdminClient.mutation(
    internal.index.deleteOrphanedFiles as any,
    { uploadedBefore },
  )) as number;
}

// A cutoff after every file stored so far, using the backend's own upload
// timestamps. Waits so that later uploads land strictly after it.
async function cutoffAfterCurrentFiles(): Promise<number> {
  const times = [...(await stored()).values()].map((f) => f._creationTime);
  const cutoff = Math.floor(Math.max(0, ...times)) + 1;
  await new Promise((resolve) => setTimeout(resolve, 25));
  return cutoff;
}

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["documents"]);
  await deleteAllStoredFiles(responseAdminClient);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip, {
    ignoreReturns: true,
    allowAdditionalFunctions: true,
  });
});

test("deletes unreferenced files uploaded before the cutoff and keeps the rest", async () => {
  const orphanBefore = await upload("abandoned form");
  const referencedBefore = await upload("submitted form");
  await reference(referencedBefore, "Submitted");
  const cutoff = await cutoffAfterCurrentFiles();
  const orphanAfter = await upload("form still open");
  expect((await stored()).get(orphanAfter)!._creationTime).toBeGreaterThan(cutoff);

  expect(await cleanup(cutoff)).toBe(1);

  const remaining = await stored();
  expect(remaining.has(orphanBefore)).toBe(false);
  expect(remaining.has(referencedBefore)).toBe(true);
  expect(remaining.has(orphanAfter)).toBe(true);
});

test("keeps a file uploaded exactly at the cutoff", async () => {
  const fileId = await upload("boundary");
  const uploadedAt = (await stored()).get(fileId)!._creationTime;

  expect(await cleanup(uploadedAt)).toBe(0);
  expect((await stored()).has(fileId)).toBe(true);

  expect(await cleanup(uploadedAt + 1)).toBe(1);
  expect((await stored()).has(fileId)).toBe(false);
});

test(
  "deletes every orphan in one call and keeps every referenced file",
  { timeout: 60_000 },
  async () => {
    // 150 orphans: more than a small read bound such as .take(100) covers.
    const orphans = await uploadMany(
      Array.from({ length: 150 }, (_, i) => `orphan-${i}`),
    );
    const referenced = await uploadMany(
      Array.from({ length: 20 }, (_, i) => `kept-${i}`),
    );
    await addDocuments(
      responseAdminClient,
      "documents",
      referenced.map((fileId, i) => ({ title: `Document ${i}`, fileId })),
    );
    const cutoff = await cutoffAfterCurrentFiles();

    expect(await cleanup(cutoff)).toBe(orphans.length);

    expect([...(await stored()).keys()].sort()).toEqual([...referenced].sort());
  },
);

test(
  "checks references even when documents far outnumber files",
  { timeout: 120_000 },
  async () => {
    const target = await upload("referenced by the newest document");
    const orphan = await upload("abandoned");
    const cutoff = await cutoffAfterCurrentFiles();
    // 1,100 documents of about 20 KB each reference 20 files that are then
    // deleted (dangling references), and one more references the target.
    // Reading every document (about 22 MB) goes past a transaction's read
    // limit, and reading only the first thousand misses the target. Looking
    // references up per stored file, in any order, only ever touches the
    // target's one document.
    const popular = await uploadMany(
      Array.from({ length: 20 }, (_, i) => `popular-${i}`),
    );
    const padding = "x".repeat(20_000);
    for (let batch = 0; batch < 11; batch++) {
      await addDocuments(
        responseAdminClient,
        "documents",
        Array.from({ length: 100 }, (_, i) => ({
          title: `Filler ${batch * 100 + i} ${padding}`,
          fileId: popular[(batch * 100 + i) % popular.length],
        })),
      );
    }
    await reference(target, "Newest");
    await deleteStoredFiles(responseAdminClient, popular);

    try {
      expect(await cleanup(cutoff)).toBe(1);

      const remaining = await stored();
      expect(remaining.has(target)).toBe(true);
      expect(remaining.has(orphan)).toBe(false);
    } finally {
      // Clear the 22 MB here, under this test's timeout, rather than in the
      // next test's beforeEach.
      await deleteAllDocuments(responseAdminClient, ["documents"]);
    }
  },
);

test("keeps a file referenced by several documents", async () => {
  const shared = await upload("shared");
  await reference(shared, "First");
  await reference(shared, "Second");
  const cutoff = await cutoffAfterCurrentFiles();

  expect(await cleanup(cutoff)).toBe(0);
  expect((await stored()).has(shared)).toBe(true);
});

test("a second run has nothing left to delete", async () => {
  await upload("one");
  await upload("two");
  const cutoff = await cutoffAfterCurrentFiles();

  expect(await cleanup(cutoff)).toBe(2);
  expect(await cleanup(cutoff)).toBe(0);
});

test("returns 0 when storage is empty", async () => {
  expect(await cleanup(Date.now())).toBe(0);
});

test("is not callable by clients", async () => {
  await expect(
    responseClient.mutation(anyApi.index.deleteOrphanedFiles, {
      uploadedBefore: Date.now(),
    }),
  ).rejects.toThrow();
});
