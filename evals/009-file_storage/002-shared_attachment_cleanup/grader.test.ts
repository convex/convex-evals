import { beforeEach, expect, test } from "vitest";
import {
  compareFunctionSpec,
  compareSchema,
  deleteAllDocuments,
  deleteAllStoredFiles,
  listStoredFiles,
  listTable,
  responseAdminClient,
  responseClient,
  uploadFile,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { Doc, Id } from "./answer/convex/_generated/dataModel";

async function upload(text: string): Promise<Id<"_storage">> {
  const uploadUrl = await responseClient.mutation(
    api.index.generateUploadUrl,
    {},
  );
  return (await uploadFile(uploadUrl, text, "text/plain")) as Id<"_storage">;
}

async function send(
  body: string,
  files: { storageId: Id<"_storage">; fileName: string }[],
): Promise<Id<"messages">> {
  return await responseClient.mutation(api.index.sendMessage, { body, files });
}

async function storedIds(): Promise<string[]> {
  return (await listStoredFiles(responseAdminClient)).map((file) => file._id);
}

async function attachments(): Promise<Doc<"attachments">[]> {
  return (await listTable(
    responseAdminClient,
    "attachments",
    200,
  )) as Doc<"attachments">[];
}

async function messages(): Promise<Doc<"messages">[]> {
  return (await listTable(
    responseAdminClient,
    "messages",
    200,
  )) as Doc<"messages">[];
}

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["attachments", "messages"]);
  await deleteAllStoredFiles(responseAdminClient);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip, { ignoreReturns: true, publicOnly: true });
});

test("sendMessage stores the message and one attachment per file", async () => {
  const report = await upload("report");
  const photo = await upload("photo");

  const messageId = await send("Here you go", [
    { storageId: report, fileName: "report.pdf" },
    { storageId: photo, fileName: "photo.png" },
  ]);

  expect((await messages()).map((m) => m._id)).toEqual([messageId]);
  const rows = await attachments();
  expect(
    rows
      .map(({ messageId, storageId, fileName }) => ({
        messageId,
        storageId,
        fileName,
      }))
      .sort((a, b) => a.fileName.localeCompare(b.fileName)),
  ).toEqual([
    { messageId, storageId: photo, fileName: "photo.png" },
    { messageId, storageId: report, fileName: "report.pdf" },
  ]);
});

test("deleting a message deletes its attachments and their stored files", async () => {
  const a = await upload("a");
  const b = await upload("b");
  const messageId = await send("Two files", [
    { storageId: a, fileName: "a.txt" },
    { storageId: b, fileName: "b.txt" },
  ]);

  await responseClient.mutation(api.index.deleteMessage, { messageId });

  expect(await messages()).toEqual([]);
  expect(await attachments()).toEqual([]);
  const stored = await storedIds();
  expect(stored).not.toContain(a);
  expect(stored).not.toContain(b);
});

test("forwardMessage shares the original's stored files", async () => {
  const a = await upload("a");
  const original = await send("Original", [{ storageId: a, fileName: "a.txt" }]);

  const forward = await responseClient.mutation(api.index.forwardMessage, {
    messageId: original,
  });

  expect(forward).not.toEqual(original);
  const forwardMessage = (await messages()).find((m) => m._id === forward);
  expect(forwardMessage?.body).toBe("Original");
  const forwardRows = (await attachments()).filter(
    (row) => row.messageId === forward,
  );
  expect(
    forwardRows.map(({ storageId, fileName }) => ({ storageId, fileName })),
  ).toEqual([{ storageId: a, fileName: "a.txt" }]);
  // Forwarding must not copy the file.
  expect(await storedIds()).toEqual([a]);
});

test("a file shared with a forward survives until its last message is deleted", async () => {
  const a = await upload("a");
  const b = await upload("b");
  const original = await send("Original", [
    { storageId: a, fileName: "a.txt" },
    { storageId: b, fileName: "b.txt" },
  ]);
  const forward = await responseClient.mutation(api.index.forwardMessage, {
    messageId: original,
  });

  await responseClient.mutation(api.index.deleteMessage, {
    messageId: original,
  });

  let stored = await storedIds();
  expect(stored).toContain(a);
  expect(stored).toContain(b);
  const remaining = await attachments();
  expect(remaining).toHaveLength(2);
  expect(remaining.every((row) => row.messageId === forward)).toBe(true);

  await responseClient.mutation(api.index.deleteMessage, { messageId: forward });

  stored = await storedIds();
  expect(stored).not.toContain(a);
  expect(stored).not.toContain(b);
  expect(await attachments()).toEqual([]);
});

test("deleting the forward first keeps the original's files", async () => {
  const a = await upload("a");
  const original = await send("Original", [{ storageId: a, fileName: "a.txt" }]);
  const forward = await responseClient.mutation(api.index.forwardMessage, {
    messageId: original,
  });

  await responseClient.mutation(api.index.deleteMessage, { messageId: forward });

  expect(await storedIds()).toContain(a);
  expect((await attachments()).map((row) => row.messageId)).toEqual([original]);
});

test("only files left unattached are deleted", async () => {
  const onlyFirst = await upload("only-first");
  const shared = await upload("shared");
  const onlySecond = await upload("only-second");
  const first = await send("First", [
    { storageId: onlyFirst, fileName: "1.txt" },
    { storageId: shared, fileName: "shared.txt" },
  ]);
  await send("Second", [
    { storageId: shared, fileName: "shared.txt" },
    { storageId: onlySecond, fileName: "2.txt" },
  ]);

  await responseClient.mutation(api.index.deleteMessage, { messageId: first });

  const stored = await storedIds();
  expect(stored).not.toContain(onlyFirst);
  expect(stored).toContain(shared);
  expect(stored).toContain(onlySecond);
});

test("deleting a message leaves unrelated stored files alone", async () => {
  // Uploaded for a message that hasn't been sent yet.
  const pending = await upload("pending");
  const a = await upload("a");
  const messageId = await send("Hello", [{ storageId: a, fileName: "a.txt" }]);

  await responseClient.mutation(api.index.deleteMessage, { messageId });

  expect(await storedIds()).toEqual([pending]);
});

test("deletes a message without attachments", async () => {
  const messageId = await send("Just text", []);

  await responseClient.mutation(api.index.deleteMessage, { messageId });

  expect(await messages()).toEqual([]);
});

test("forwardMessage and deleteMessage throw for a missing message", async () => {
  const messageId = await send("Soon gone", []);
  await deleteAllDocuments(responseAdminClient, ["messages"]);

  await expect(
    responseClient.mutation(api.index.forwardMessage, { messageId }),
  ).rejects.toThrow();
  await expect(
    responseClient.mutation(api.index.deleteMessage, { messageId }),
  ).rejects.toThrow();
});
