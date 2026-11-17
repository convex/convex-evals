import { v } from "convex/values";
import { internalAction } from "./_generated/server";

export const runImport = internalAction({
  args: { source: v.string() },
  handler: async (_ctx, args) => {
    if (args.source.startsWith("slow:")) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    if (args.source.endsWith(".broken")) {
      throw new Error(`Cannot parse ${args.source}`);
    }
    return null;
  },
});
