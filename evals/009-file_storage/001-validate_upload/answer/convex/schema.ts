import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  listings: defineTable({
    title: v.string(),
    photoStorageId: v.optional(v.id("_storage")),
  }),
});
