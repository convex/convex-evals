import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

// How the scheduler's run states map onto the statuses the app shows. The
// app never cancels imports, but every state needs a status.
const STATUS_BY_STATE = {
  pending: "pending",
  inProgress: "pending",
  success: "succeeded",
  failed: "failed",
  canceled: "failed",
} as const;

export const startImport = mutation({
  args: {
    source: v.string(),
  },
  // Annotated so the handler's type doesn't depend on `internal`, which would
  // make TypeScript's inference circular.
  handler: async (ctx, args): Promise<Id<"imports">> => {
    const jobId = await ctx.scheduler.runAfter(
      0,
      internal.importWorker.runImport,
      { source: args.source },
    );
    return await ctx.db.insert("imports", { source: args.source, jobId });
  },
});

export const getImport = query({
  args: {
    importId: v.id("imports"),
  },
  handler: async (ctx, args) => {
    const record = await ctx.db.get("imports", args.importId);
    if (record === null) {
      return null;
    }
    // A run that throws can't record its own failure. The scheduler keeps
    // every run's state in the `_scheduled_functions` system table, including
    // the error message of a failed run.
    const job = await ctx.db.system.get("_scheduled_functions", record.jobId);
    if (job === null) {
      throw new Error("Scheduled run not found");
    }
    return {
      source: record.source,
      status: STATUS_BY_STATE[job.state.kind],
      error: job.state.kind === "failed" ? job.state.error : null,
    };
  },
});
