import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  events: defineTable({
    name: v.string(),
    ticketsRemaining: v.number(),
  }),
  reservations: defineTable({
    eventId: v.id("events"),
    quantity: v.number(),
  }),
});
