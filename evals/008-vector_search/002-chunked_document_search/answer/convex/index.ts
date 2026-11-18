import { v } from "convex/values";
import { action, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

// Every document has at most this many chunks.
const MAX_CHUNKS_PER_DOCUMENT = 10;
// The most results a single vector search can return.
const MAX_VECTOR_RESULTS = 256;

type ChunkWithTitle = {
  documentId: Id<"documents">;
  text: string;
  title: string;
};

export const searchDocuments = action({
  args: {
    embedding: v.array(v.float64()),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    // One document can own up to 10 of the closest chunks, so fetching 10
    // chunks per requested document guarantees `limit` distinct documents
    // whenever that many exist (20 documents -> 200 chunks, under the cap).
    const hits = await ctx.vectorSearch("chunks", "by_embedding", {
      vector: args.embedding,
      limit: Math.min(MAX_VECTOR_RESULTS, args.limit * MAX_CHUNKS_PER_DOCUMENT),
    });

    const chunks: (ChunkWithTitle | null)[] = await ctx.runQuery(
      internal.index.getChunksWithTitles,
      { ids: hits.map((hit) => hit._id) },
    );

    // Hits arrive in descending score order, so the first hit seen for a
    // document is its best chunk.
    const results: {
      documentId: Id<"documents">;
      title: string;
      bestChunk: string;
      score: number;
    }[] = [];
    const seen = new Set<Id<"documents">>();
    for (let i = 0; i < hits.length && results.length < args.limit; i++) {
      const chunk = chunks[i];
      if (chunk === null || seen.has(chunk.documentId)) {
        continue;
      }
      seen.add(chunk.documentId);
      results.push({
        documentId: chunk.documentId,
        title: chunk.title,
        bestChunk: chunk.text,
        score: hits[i]._score,
      });
    }
    return results;
  },
});

export const getChunksWithTitles = internalQuery({
  args: {
    ids: v.array(v.id("chunks")),
  },
  handler: async (ctx, args): Promise<(ChunkWithTitle | null)[]> => {
    return await Promise.all(
      args.ids.map(async (id) => {
        const chunk = await ctx.db.get("chunks", id);
        if (chunk === null) {
          return null;
        }
        const document = await ctx.db.get("documents", chunk.documentId);
        if (document === null) {
          return null;
        }
        return {
          documentId: chunk.documentId,
          text: chunk.text,
          title: document.title,
        };
      }),
    );
  },
});
