import { v } from "convex/values";
import { internalQuery, mutation } from "./_generated/server";

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

export const createShareLink = mutation({
  args: {
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const file = await ctx.db.system.get("_storage", args.storageId);
    if (file === null) {
      throw new Error("File not found");
    }
    // The token is the only secret in the link, so it is random rather than
    // derived from the storage ID or the link's document ID.
    const token = crypto.randomUUID();
    await ctx.db.insert("shareLinks", {
      token,
      storageId: args.storageId,
      revoked: false,
    });
    return token;
  },
});

export const revokeShareLink = mutation({
  args: {
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const link = await ctx.db
      .query("shareLinks")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (link === null) {
      throw new Error("Share link not found");
    }
    await ctx.db.patch("shareLinks", link._id, { revoked: true });
  },
});

export const getActiveLink = internalQuery({
  args: {
    token: v.string(),
  },
  handler: async (ctx, args) => {
    const link = await ctx.db
      .query("shareLinks")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (link === null || link.revoked) {
      return null;
    }
    return { storageId: link.storageId };
  },
});
