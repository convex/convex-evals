import { ConvexError, v } from "convex/values";
import { action, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

type CheckoutFailure = {
  code: "CART_NOT_FOUND" | "CART_ALREADY_ORDERED" | "OUT_OF_STOCK";
  productId?: Id<"products">;
};

export const checkout = action({
  args: {
    cartId: v.id("carts"),
  },
  handler: async (ctx, args): Promise<Id<"orders">> => {
    try {
      return await ctx.runMutation(internal.index.placeOrder, args);
    } catch (error) {
      if (!(error instanceof ConvexError)) {
        throw error;
      }
      // placeOrder threw, so everything it wrote was rolled back, including
      // anything it might have logged. The action isn't transactional, so it
      // records the failure in its own mutation and then rethrows the same
      // ConvexError for the client.
      const failure = error.data as CheckoutFailure;
      await ctx.runMutation(internal.index.recordFailure, {
        cartId: args.cartId,
        code: failure.code,
        productId: failure.productId,
      });
      throw error;
    }
  },
});

export const placeOrder = internalMutation({
  args: {
    cartId: v.id("carts"),
  },
  handler: async (ctx, args) => {
    const cart = await ctx.db.get("carts", args.cartId);
    if (cart === null) {
      throw new ConvexError({ code: "CART_NOT_FOUND" });
    }
    if (cart.status === "ordered") {
      throw new ConvexError({ code: "CART_ALREADY_ORDERED" });
    }

    // Throwing partway through still leaves no stock changes behind, because
    // a mutation that throws commits none of its writes.
    for (const item of cart.items) {
      const product = await ctx.db.get("products", item.productId);
      if (product === null || product.stock < item.quantity) {
        throw new ConvexError({
          code: "OUT_OF_STOCK",
          productId: item.productId,
        });
      }
      await ctx.db.patch("products", item.productId, {
        stock: product.stock - item.quantity,
      });
    }

    await ctx.db.patch("carts", args.cartId, { status: "ordered" });
    return await ctx.db.insert("orders", { cartId: args.cartId });
  },
});

export const recordFailure = internalMutation({
  args: {
    cartId: v.id("carts"),
    code: v.string(),
    productId: v.optional(v.id("products")),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("checkoutFailures", args);
  },
});
