import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

export const savePhoto = mutation({
  args: {
    storageId: v.id("_storage"),
    caption: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("photos", {
      storageId: args.storageId,
      caption: args.caption,
    });
  },
});

export const listPhotos = query({
  args: {},
  handler: async (ctx) => {
    const photos = await ctx.db.query("photos").order("desc").take(20);
    const results = [];
    for (const photo of photos) {
      // Content type and size were recorded by Convex when the file was
      // uploaded; they live in the `_storage` system table.
      const metadata = await ctx.db.system.get("_storage", photo.storageId);
      const url = await ctx.storage.getUrl(photo.storageId);
      if (metadata === null || url === null) {
        // The file was deleted from storage, so there is nothing to show.
        continue;
      }
      results.push({
        _id: photo._id,
        caption: photo.caption,
        url,
        contentType: metadata.contentType ?? "",
        size: metadata.size,
      });
    }
    return results;
  },
});
