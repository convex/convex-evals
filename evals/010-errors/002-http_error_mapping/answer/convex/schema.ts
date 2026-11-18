import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  products: defineTable({
    sku: v.string(),
    stock: v.number(),
  }).index("by_sku", ["sku"]),
  orders: defineTable({
    sku: v.string(),
    quantity: v.number(),
  }),
});
