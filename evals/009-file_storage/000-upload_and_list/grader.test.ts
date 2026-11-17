import { beforeEach, expect, test } from "vitest";
import {
  compareFunctionSpec,
  compareSchema,
  deleteAllDocuments,
  deleteAllStoredFiles,
  responseAdminClient,
  responseClient,
  uploadFile,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { Id } from "./answer/convex/_generated/dataModel";

type Photo = {
  _id: Id<"photos">;
  caption: string;
  url: string;
  contentType: string;
  size: number;
};

// Deterministic file contents of the given size.
function bytes(size: number, seed: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, i) => (i * 31 + seed) % 256);
}

// The first two steps of the browser flow: get an upload URL, POST the file.
async function upload(
  contents: Uint8Array,
  contentType: string,
): Promise<Id<"_storage">> {
  const uploadUrl = await responseClient.mutation(
    api.index.generateUploadUrl,
    {},
  );
  expect(typeof uploadUrl).toBe("string");
  return (await uploadFile(uploadUrl, contents, contentType)) as Id<"_storage">;
}

async function save(
  storageId: Id<"_storage">,
  caption: string,
): Promise<Id<"photos">> {
  return await responseClient.mutation(api.index.savePhoto, {
    storageId,
    caption,
  });
}

async function uploadPhoto(
  contents: Uint8Array,
  contentType: string,
  caption: string,
): Promise<Id<"photos">> {
  return await save(await upload(contents, contentType), caption);
}

async function listPhotos(): Promise<Photo[]> {
  return (await responseClient.query(api.index.listPhotos, {})) as Photo[];
}

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["photos"]);
  await deleteAllStoredFiles(responseAdminClient);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip, { ignoreReturns: true, publicOnly: true });
});

test("lists a saved photo with a working download URL and its recorded metadata", async () => {
  const contents = bytes(2048, 7);
  const photoId = await uploadPhoto(contents, "image/png", "Sunset");

  const photos = await listPhotos();

  expect(photos).toHaveLength(1);
  const [photo] = photos;
  expect(Object.keys(photo).sort()).toEqual([
    "_id",
    "caption",
    "contentType",
    "size",
    "url",
  ]);
  expect(photo._id).toEqual(photoId);
  expect(photo.caption).toBe("Sunset");
  expect(photo.contentType).toBe("image/png");
  expect(photo.size).toBe(2048);

  const download = await fetch(photo.url);
  expect(download.status).toBe(200);
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(contents);
});

test("reports each photo's own content type and size", async () => {
  const jpegId = await uploadPhoto(bytes(1000, 1), "image/jpeg", "Beach");
  const webpId = await uploadPhoto(bytes(3001, 2), "image/webp", "Forest");

  const photos = await listPhotos();
  const byId = new Map(photos.map((photo) => [photo._id, photo]));

  expect(byId.get(jpegId)).toMatchObject({
    caption: "Beach",
    contentType: "image/jpeg",
    size: 1000,
  });
  expect(byId.get(webpId)).toMatchObject({
    caption: "Forest",
    contentType: "image/webp",
    size: 3001,
  });

  const forest = await fetch(byId.get(webpId)!.url);
  expect(new Uint8Array(await forest.arrayBuffer())).toEqual(bytes(3001, 2));
});

test(
  "returns the 20 most recently saved photos, newest first",
  { timeout: 30_000 },
  async () => {
    // Upload everything first, then save in a different order, so the order
    // of saving and the order of uploading disagree.
    const uploads = await Promise.all(
      Array.from({ length: 22 }, (_, i) => upload(bytes(10 + i, i), "image/png")),
    );
    const saveOrder = Array.from({ length: 22 }, (_, i) => (i * 7) % 22);
    for (const i of saveOrder) {
      await save(uploads[i], `photo-${i}`);
    }

    const photos = await listPhotos();

    const newestFirst = [...saveOrder].reverse().slice(0, 20);
    expect(photos.map((photo) => photo.caption)).toEqual(
      newestFirst.map((i) => `photo-${i}`),
    );
    expect(photos.map((photo) => photo.size)).toEqual(
      newestFirst.map((i) => 10 + i),
    );
  },
);

test("savePhoto only accepts storage IDs", async () => {
  const photoId = await uploadPhoto(bytes(10, 3), "image/png", "First");

  await expect(
    responseClient.mutation(api.index.savePhoto, {
      storageId: photoId as unknown as Id<"_storage">,
      caption: "Not a file",
    }),
  ).rejects.toThrow();
});

test("returns an empty array when there are no photos", async () => {
  expect(await listPhotos()).toEqual([]);
});
