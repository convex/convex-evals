import { v } from "convex/values";
import { mutation } from "./_generated/server";

const ALLOWED_CONTENT_TYPES = new Set(["image/png", "image/jpeg"]);
const MAX_BYTES = 1024 * 1024;

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

export const attachPhoto = mutation({
  args: {
    listingId: v.id("listings"),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const listing = await ctx.db.get("listings", args.listingId);
    if (listing === null) {
      throw new Error("Listing not found");
    }

    // The client controls the upload request, so trust only what Convex
    // recorded for the stored file.
    const file = await ctx.db.system.get("_storage", args.storageId);
    if (file === null) {
      throw new Error("File not found");
    }

    let reason: "unsupported_type" | "too_large" | null = null;
    if (!file.contentType || !ALLOWED_CONTENT_TYPES.has(file.contentType)) {
      reason = "unsupported_type";
    } else if (file.size > MAX_BYTES) {
      reason = "too_large";
    }

    if (reason !== null) {
      // Storage deletes in a mutation are transactional, so this returns a
      // result instead of throwing: throwing would roll the delete back.
      await ctx.storage.delete(args.storageId);
      return { ok: false as const, reason };
    }

    await ctx.db.patch("listings", args.listingId, {
      photoStorageId: args.storageId,
    });
    return { ok: true as const };
  },
});
