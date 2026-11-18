import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  notes: defineTable({
    ownerTokenIdentifier: v.string(),
    visibility: v.union(v.literal("private"), v.literal("public")),
    text: v.string(),
    embedding: v.array(v.float64()),
  }).vectorIndex("by_embedding", {
    vectorField: "embedding",
    dimensions: 8,
    // Both fields are filterable so one search can match "mine OR public".
    filterFields: ["ownerTokenIdentifier", "visibility"],
  }),
});
