import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  imports: defineTable({
    source: v.string(),
    jobId: v.id("_scheduled_functions"),
  }),
});
