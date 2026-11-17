import { v } from "convex/values";
import { action, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc } from "./_generated/dataModel";

export const similarProducts = action({
  args: {
    productId: v.id("products"),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    // Actions have no database access, so the source product's embedding is
    // read through an internal query.
    const sources: (Doc<"products"> | null)[] = await ctx.runQuery(
      internal.index.getProducts,
      { ids: [args.productId] },
    );
    const product = sources[0];
    if (product === null) {
      return [];
    }

    // The product is always its own best match, so ask for one extra hit and
    // drop it, which still leaves `limit` other products when they exist.
    const hits = await ctx.vectorSearch("products", "by_embedding", {
      vector: product.embedding,
      limit: args.limit + 1,
      filter: (q) => q.eq("category", product.category),
    });
    const others = hits
      .filter((hit) => hit._id !== product._id)
      .slice(0, args.limit);

    const docs: (Doc<"products"> | null)[] = await ctx.runQuery(
      internal.index.getProducts,
      { ids: others.map((hit) => hit._id) },
    );

    const results = [];
    for (let i = 0; i < others.length; i++) {
      const doc = docs[i];
      if (doc === null) {
        continue;
      }
      results.push({ _id: doc._id, name: doc.name, score: others[i]._score });
    }
    return results;
  },
});

export const getProducts = internalQuery({
  args: {
    ids: v.array(v.id("products")),
  },
  handler: async (ctx, args) => {
    return await Promise.all(
      args.ids.map((id) => ctx.db.get("products", id)),
    );
  },
});
