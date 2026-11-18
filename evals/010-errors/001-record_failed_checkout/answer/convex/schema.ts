import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  products: defineTable({
    name: v.string(),
    stock: v.number(),
  }),
  carts: defineTable({
    status: v.union(v.literal("open"), v.literal("ordered")),
    items: v.array(
      v.object({
        productId: v.id("products"),
        quantity: v.number(),
      }),
    ),
  }),
  orders: defineTable({
    cartId: v.id("carts"),
  }),
  checkoutFailures: defineTable({
    cartId: v.id("carts"),
    code: v.string(),
    productId: v.optional(v.id("products")),
  }),
});
