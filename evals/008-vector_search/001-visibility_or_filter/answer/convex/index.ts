import { v } from "convex/values";
import { action, internalQuery, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc } from "./_generated/dataModel";

export const createNote = mutation({
  args: {
    text: v.string(),
    visibility: v.union(v.literal("private"), v.literal("public")),
    embedding: v.array(v.float64()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      throw new Error("Not authenticated");
    }
    return await ctx.db.insert("notes", {
      ownerTokenIdentifier: identity.tokenIdentifier,
      visibility: args.visibility,
      text: args.text,
      embedding: args.embedding,
    });
  },
});

export const searchNotes = action({
  args: {
    embedding: v.array(v.float64()),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      throw new Error("Not authenticated");
    }

    // Vector filters are ORs of equalities on filter fields, which is exactly
    // "notes I own OR public notes". Filtering inside the search means notes
    // the caller can't see never crowd visible ones out of the top results.
    const hits = await ctx.vectorSearch("notes", "by_embedding", {
      vector: args.embedding,
      limit: args.limit,
      filter: (q) =>
        q.or(
          q.eq("ownerTokenIdentifier", identity.tokenIdentifier),
          q.eq("visibility", "public"),
        ),
    });

    const notes: (Doc<"notes"> | null)[] = await ctx.runQuery(
      internal.index.getNotes,
      { ids: hits.map((hit) => hit._id) },
    );

    const results = [];
    for (let i = 0; i < hits.length; i++) {
      const note = notes[i];
      if (note === null) {
        continue;
      }
      results.push({ _id: note._id, text: note.text, score: hits[i]._score });
    }
    return results;
  },
});

export const getNotes = internalQuery({
  args: {
    ids: v.array(v.id("notes")),
  },
  handler: async (ctx, args) => {
    return await Promise.all(args.ids.map((id) => ctx.db.get("notes", id)));
  },
});
