import { ConvexError, v } from "convex/values";
import { mutation } from "./_generated/server";

export const placeOrder = mutation({
  args: { sku: v.string(), quantity: v.number() },
  handler: async (ctx, args) => {
    if (!Number.isInteger(args.quantity) || args.quantity < 1) {
      throw new ConvexError({ code: "INVALID_QUANTITY" });
    }
    const product = await ctx.db
      .query("products")
      .withIndex("by_sku", (q) => q.eq("sku", args.sku))
      .unique();
    if (product === null) {
      throw new ConvexError({ code: "PRODUCT_NOT_FOUND", sku: args.sku });
    }
    if (product.stock < args.quantity) {
      throw new ConvexError({ code: "OUT_OF_STOCK", available: product.stock });
    }
    await ctx.db.patch("products", product._id, {
      stock: product.stock - args.quantity,
    });
    return await ctx.db.insert("orders", {
      sku: args.sku,
      quantity: args.quantity,
    });
  },
});
