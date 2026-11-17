import { v } from "convex/values";
import { action, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc } from "./_generated/dataModel";

export const searchArticles = action({
  args: {
    embedding: v.array(v.float64()),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    // Vector search only runs in actions and returns IDs and scores, so the
    // matching articles are loaded afterwards in a single internal query.
    const hits = await ctx.vectorSearch("articles", "by_embedding", {
      vector: args.embedding,
      limit: args.limit,
    });

    const articles: (Doc<"articles"> | null)[] = await ctx.runQuery(
      internal.index.getArticles,
      { ids: hits.map((hit) => hit._id) },
    );

    const results = [];
    for (let i = 0; i < hits.length; i++) {
      const article = articles[i];
      // An article deleted between the search and the fetch is skipped.
      if (article === null) {
        continue;
      }
      results.push({
        _id: article._id,
        title: article.title,
        score: hits[i]._score,
      });
    }
    return results;
  },
});

export const getArticles = internalQuery({
  args: {
    ids: v.array(v.id("articles")),
  },
  handler: async (ctx, args) => {
    return await Promise.all(
      args.ids.map((id) => ctx.db.get("articles", id)),
    );
  },
});
