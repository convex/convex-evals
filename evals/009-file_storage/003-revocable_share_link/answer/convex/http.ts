import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

http.route({
  path: "/share",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const token = new URL(request.url).searchParams.get("token");
    if (token === null) {
      return new Response("Not found", { status: 404 });
    }
    const link = await ctx.runQuery(internal.index.getActiveLink, { token });
    if (link === null) {
      return new Response("Not found", { status: 404 });
    }

    // Stream the bytes from this endpoint instead of redirecting to a storage
    // URL. A storage URL keeps working until the file is deleted, so handing
    // one out would let a revoked link's recipient keep downloading.
    const file = await ctx.storage.get(link.storageId);
    if (file === null) {
      return new Response("Not found", { status: 404 });
    }
    // The Blob carries the content type recorded at upload.
    return new Response(file, {
      status: 200,
      headers: { "Content-Type": file.type || "application/octet-stream" },
    });
  }),
});

export default http;
