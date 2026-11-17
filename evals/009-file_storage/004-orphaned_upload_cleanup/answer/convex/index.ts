import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

// The deployment never stores more than this many files.
const MAX_STORED_FILES = 500;

export const deleteOrphanedFiles = internalMutation({
  args: {
    uploadedBefore: v.number(),
  },
  handler: async (ctx, args) => {
    // Files uploaded straight to storage exist only in the `_storage` system
    // table until a document references them, so that is what gets scanned.
    const candidates = await ctx.db.system
      .query("_storage")
      .withIndex("by_creation_time", (q) =>
        q.lt("_creationTime", args.uploadedBefore),
      )
      .take(MAX_STORED_FILES);

    let deleted = 0;
    for (const file of candidates) {
      const reference = await ctx.db
        .query("documents")
        .withIndex("by_fileId", (q) => q.eq("fileId", file._id))
        .first();
      if (reference === null) {
        await ctx.storage.delete(file._id);
        deleted++;
      }
    }
    return deleted;
  },
});
