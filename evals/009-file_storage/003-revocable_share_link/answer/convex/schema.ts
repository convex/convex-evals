import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  shareLinks: defineTable({
    token: v.string(),
    storageId: v.id("_storage"),
    revoked: v.boolean(),
  }).index("by_token", ["token"]),
});
