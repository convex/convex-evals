import { v } from "convex/values";
import { mutation } from "./_generated/server";

// A message has at most 10 attachments.
const MAX_ATTACHMENTS = 10;

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

export const sendMessage = mutation({
  args: {
    body: v.string(),
    files: v.array(
      v.object({
        storageId: v.id("_storage"),
        fileName: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    if (args.files.length > MAX_ATTACHMENTS) {
      throw new Error(`A message can have at most ${MAX_ATTACHMENTS} files`);
    }
    const messageId = await ctx.db.insert("messages", { body: args.body });
    for (const file of args.files) {
      await ctx.db.insert("attachments", {
        messageId,
        storageId: file.storageId,
        fileName: file.fileName,
      });
    }
    return messageId;
  },
});

export const forwardMessage = mutation({
  args: {
    messageId: v.id("messages"),
  },
  handler: async (ctx, args) => {
    const message = await ctx.db.get("messages", args.messageId);
    if (message === null) {
      throw new Error("Message not found");
    }
    const attachments = await ctx.db
      .query("attachments")
      .withIndex("by_messageId", (q) => q.eq("messageId", args.messageId))
      .take(MAX_ATTACHMENTS);

    const newMessageId = await ctx.db.insert("messages", { body: message.body });
    for (const attachment of attachments) {
      // The forward shares the stored file; nothing is copied.
      await ctx.db.insert("attachments", {
        messageId: newMessageId,
        storageId: attachment.storageId,
        fileName: attachment.fileName,
      });
    }
    return newMessageId;
  },
});

export const deleteMessage = mutation({
  args: {
    messageId: v.id("messages"),
  },
  handler: async (ctx, args) => {
    const message = await ctx.db.get("messages", args.messageId);
    if (message === null) {
      throw new Error("Message not found");
    }
    const attachments = await ctx.db
      .query("attachments")
      .withIndex("by_messageId", (q) => q.eq("messageId", args.messageId))
      .take(MAX_ATTACHMENTS);

    for (const attachment of attachments) {
      await ctx.db.delete("attachments", attachment._id);
    }
    await ctx.db.delete("messages", args.messageId);

    // Deleting documents never deletes the files they reference, so each
    // file is deleted here once no remaining attachment points at it.
    const storageIds = new Set(attachments.map((a) => a.storageId));
    for (const storageId of storageIds) {
      const stillAttached = await ctx.db
        .query("attachments")
        .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
        .first();
      // Skip files already removed from storage, which would make the
      // delete throw and leave the message impossible to delete.
      if (
        stillAttached === null &&
        (await ctx.db.system.get("_storage", storageId)) !== null
      ) {
        await ctx.storage.delete(storageId);
      }
    }
  },
});
