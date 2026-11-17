import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  messages: defineTable({
    body: v.string(),
  }),
  attachments: defineTable({
    messageId: v.id("messages"),
    storageId: v.id("_storage"),
    fileName: v.string(),
  })
    .index("by_messageId", ["messageId"])
    .index("by_storageId", ["storageId"]),
});
