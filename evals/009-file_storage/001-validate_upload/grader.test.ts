import { beforeEach, expect, test } from "vitest";
import {
  addDocuments,
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

const MIB = 1024 * 1024;

async function createListing(title: string): Promise<Id<"listings">> {
  await addDocuments(responseAdminClient, "listings", [{ title }]);
  const listings = (await listTable(
    responseAdminClient,
    "listings",
  )) as Doc<"listings">[];
  return listings.find((listing) => listing.title === title)!._id;
}

async function getListing(id: Id<"listings">): Promise<Doc<"listings">> {
  const listings = (await listTable(
    responseAdminClient,
    "listings",
  )) as Doc<"listings">[];
  return listings.find((listing) => listing._id === id)!;
}

// Upload through the app's own upload URL, as the browser would. Leaving out
// the content type sends no Content-Type header at all.
async function upload(
  size: number,
  contentType?: string,
): Promise<Id<"_storage">> {
  const uploadUrl = await responseClient.mutation(
    api.index.generateUploadUrl,
    {},
  );
  const contents = new Uint8Array(size).fill(42);
  return (await uploadFile(uploadUrl, contents, contentType)) as Id<"_storage">;
}

async function storedIds(): Promise<string[]> {
  return (await listStoredFiles(responseAdminClient)).map((file) => file._id);
}

async function attach(listingId: Id<"listings">, storageId: Id<"_storage">) {
  return await responseClient.mutation(api.index.attachPhoto, {
    listingId,
    storageId,
  });
}

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["listings"]);
  await deleteAllStoredFiles(responseAdminClient);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip, { ignoreReturns: true, publicOnly: true });
});

test("attaches a PNG within the size limit", async () => {
  const listingId = await createListing("Bike");
  const storageId = await upload(2000, "image/png");

  expect(await attach(listingId, storageId)).toEqual({ ok: true });

  expect((await getListing(listingId)).photoStorageId).toEqual(storageId);
  expect(await storedIds()).toContain(storageId);
});

test("attaches a JPEG of exactly 1 MiB", async () => {
  const listingId = await createListing("Desk");
  const storageId = await upload(MIB, "image/jpeg");

  expect(await attach(listingId, storageId)).toEqual({ ok: true });
  expect((await getListing(listingId)).photoStorageId).toEqual(storageId);
});

test("rejects and deletes an image larger than 1 MiB", async () => {
  const listingId = await createListing("Lamp");
  const storageId = await upload(MIB + 1, "image/png");

  expect(await attach(listingId, storageId)).toEqual({
    ok: false,
    reason: "too_large",
  });

  expect((await getListing(listingId)).photoStorageId).toBeUndefined();
  expect(await storedIds()).not.toContain(storageId);
});

test("rejects and deletes files that are not PNG or JPEG", async () => {
  const listingId = await createListing("Chair");

  for (const contentType of [
    "text/plain",
    "image/gif",
    "image/svg+xml",
    "image/webp",
    undefined,
  ]) {
    const storageId = await upload(100, contentType);
    expect(await attach(listingId, storageId)).toEqual({
      ok: false,
      reason: "unsupported_type",
    });
    expect(await storedIds()).not.toContain(storageId);
  }
  expect((await getListing(listingId)).photoStorageId).toBeUndefined();
});

test("reports the content type before the size", async () => {
  const listingId = await createListing("Sofa");
  const storageId = await upload(2 * MIB, "application/pdf");

  expect(await attach(listingId, storageId)).toEqual({
    ok: false,
    reason: "unsupported_type",
  });
  expect(await storedIds()).not.toContain(storageId);
});

test("a rejected upload leaves the listing's existing photo in place", async () => {
  const listingId = await createListing("Table");
  const goodId = await upload(500, "image/jpeg");
  expect(await attach(listingId, goodId)).toEqual({ ok: true });

  const badId = await upload(MIB + 100, "image/jpeg");
  expect(await attach(listingId, badId)).toEqual({
    ok: false,
    reason: "too_large",
  });

  expect((await getListing(listingId)).photoStorageId).toEqual(goodId);
  const stored = await storedIds();
  expect(stored).toContain(goodId);
  expect(stored).not.toContain(badId);
});

test("throws when the listing does not exist", async () => {
  const listingId = await createListing("Gone");
  await deleteAllDocuments(responseAdminClient, ["listings"]);
  const storageId = await upload(100, "image/png");

  await expect(attach(listingId, storageId)).rejects.toThrow();
});

test("throws when the file is no longer in storage", async () => {
  const listingId = await createListing("Rug");
  const storageId = await upload(100, "image/png");
  await deleteAllStoredFiles(responseAdminClient);

  await expect(attach(listingId, storageId)).rejects.toThrow();
  expect((await getListing(listingId)).photoStorageId).toBeUndefined();
});
