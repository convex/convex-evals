import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  photos: defineTable({
    storageId: v.id("_storage"),
    caption: v.string(),
  }),
});
