import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  documents: defineTable({
    title: v.string(),
    fileId: v.id("_storage"),
  }).index("by_fileId", ["fileId"]),
});
