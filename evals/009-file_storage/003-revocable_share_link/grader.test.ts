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
  siteUrl,
  uploadFile,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { Doc, Id } from "./answer/convex/_generated/dataModel";

const PNG_BYTES = Uint8Array.from({ length: 1500 }, (_, i) => (i * 7) % 256);

async function upload(
  contents: Uint8Array | string,
  contentType: string,
): Promise<Id<"_storage">> {
  const uploadUrl = await responseClient.mutation(
    api.index.generateUploadUrl,
    {},
  );
  return (await uploadFile(uploadUrl, contents, contentType)) as Id<"_storage">;
}

async function createLink(storageId: Id<"_storage">): Promise<string> {
  const token = await responseClient.mutation(api.index.createShareLink, {
    storageId,
  });
  expect(typeof token).toBe("string");
  return token;
}

// The media type of a Content-Type header, without parameters like charset.
function mediaType(response: Response): string | undefined {
  return response.headers.get("content-type")?.split(";")[0].trim();
}

function shareUrl(token: string): string {
  return `${siteUrl}/share?token=${encodeURIComponent(token)}`;
}

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["shareLinks"]);
  await deleteAllStoredFiles(responseAdminClient);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  // Internal helpers used by the HTTP action are not dictated by the task.
  await compareFunctionSpec(skip, { ignoreReturns: true, publicOnly: true });
});

test("a share link serves the file's contents and content type", async () => {
  const storageId = await upload(PNG_BYTES, "image/png");
  const token = await createLink(storageId);

  const response = await fetch(shareUrl(token));

  expect(response.status).toBe(200);
  expect(mediaType(response)).toBe("image/png");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
});

test("each link serves its own file", async () => {
  const csvId = await upload("a,b\n1,2\n", "text/csv");
  const jpegId = await upload(new Uint8Array([255, 216, 255, 1, 2]), "image/jpeg");
  const csvToken = await createLink(csvId);
  const jpegToken = await createLink(jpegId);

  const csv = await fetch(shareUrl(csvToken));
  expect(csv.status).toBe(200);
  expect(mediaType(csv)).toBe("text/csv");
  expect(await csv.text()).toBe("a,b\n1,2\n");

  const jpeg = await fetch(shareUrl(jpegToken));
  expect(jpeg.status).toBe(200);
  expect(mediaType(jpeg)).toBe("image/jpeg");
  expect(new Uint8Array(await jpeg.arrayBuffer())).toEqual(
    new Uint8Array([255, 216, 255, 1, 2]),
  );
});

test("revoking a link cuts off access, including for someone who already opened it", async () => {
  const storageId = await upload(PNG_BYTES, "image/png");
  const token = await createLink(storageId);

  // Open the link the way a recipient would, keeping anything it hands out.
  const opened = await fetch(shareUrl(token), { redirect: "manual" });
  const redirectTarget = opened.headers.get("location");

  await responseClient.mutation(api.index.revokeShareLink, { token });

  const afterRevoke = await fetch(shareUrl(token));
  expect(afterRevoke.status).toBe(404);

  // A redirect target, such as a storage URL, must not keep the file
  // available after the link that handed it out was revoked.
  if (redirectTarget !== null) {
    const target = new URL(redirectTarget, shareUrl(token)).toString();
    const viaTarget = await fetch(target);
    expect(viaTarget.status).not.toBe(200);
  }
  // Revoking a link never deletes the file.
  expect((await listStoredFiles(responseAdminClient)).map((f) => f._id)).toContain(
    storageId,
  );
});

test("revoking one link leaves the file's other links working", async () => {
  const storageId = await upload(PNG_BYTES, "image/png");
  const first = await createLink(storageId);
  const second = await createLink(storageId);
  // Someone opens the first link before it is revoked.
  const opened = await fetch(shareUrl(first), { redirect: "manual" });
  const redirectTarget = opened.headers.get("location");

  await responseClient.mutation(api.index.revokeShareLink, { token: first });

  expect((await fetch(shareUrl(first))).status).toBe(404);
  if (redirectTarget !== null) {
    const target = new URL(redirectTarget, shareUrl(first)).toString();
    expect((await fetch(target)).status).not.toBe(200);
  }
  const stillShared = await fetch(shareUrl(second));
  expect(stillShared.status).toBe(200);
  expect(new Uint8Array(await stillShared.arrayBuffer())).toEqual(PNG_BYTES);
});

test("tokens are distinct and are not the storage ID or link ID", async () => {
  const storageId = await upload(PNG_BYTES, "image/png");
  const first = await createLink(storageId);
  const second = await createLink(storageId);

  expect(first).not.toBe(second);
  const links = (await listTable(
    responseAdminClient,
    "shareLinks",
  )) as Doc<"shareLinks">[];
  expect(links.map((link) => link.token).sort()).toEqual([first, second].sort());
  for (const link of links) {
    expect(link.token).not.toBe(storageId);
    expect(link.token).not.toBe(link._id);
    expect(link.token.length).toBeGreaterThanOrEqual(16);
    expect(link.revoked).toBe(false);
  }
});

test("a storage ID does not work as a token", async () => {
  const storageId = await upload(PNG_BYTES, "image/png");
  await createLink(storageId);

  expect((await fetch(shareUrl(storageId))).status).toBe(404);
});

test("responds 404 for missing or unknown tokens", async () => {
  expect((await fetch(`${siteUrl}/share`)).status).toBe(404);
  expect((await fetch(shareUrl("not-a-real-token"))).status).toBe(404);
});

test("responds 404 once the file has been deleted from storage", async () => {
  const storageId = await upload(PNG_BYTES, "image/png");
  const token = await createLink(storageId);
  await deleteAllStoredFiles(responseAdminClient);

  expect((await fetch(shareUrl(token))).status).toBe(404);
});

test("createShareLink throws for a file that is not in storage", async () => {
  const storageId = await upload(PNG_BYTES, "image/png");
  await deleteAllStoredFiles(responseAdminClient);

  await expect(
    responseClient.mutation(api.index.createShareLink, { storageId }),
  ).rejects.toThrow();
});

test("revokeShareLink throws for an unknown token", async () => {
  await expect(
    responseClient.mutation(api.index.revokeShareLink, {
      token: "not-a-real-token",
    }),
  ).rejects.toThrow();
});
