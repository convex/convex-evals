import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";

const MIN_QUANTITY = 1;
const MAX_QUANTITY = 10;

export const reserveTickets = mutation({
  args: {
    eventId: v.id("events"),
    quantity: v.number(),
  },
  handler: async (ctx, args) => {
    // ConvexError's data reaches the client intact on `error.data`, unlike a
    // plain Error, whose message production deployments hide from clients.
    if (
      !Number.isInteger(args.quantity) ||
      args.quantity < MIN_QUANTITY ||
      args.quantity > MAX_QUANTITY
    ) {
      throw new ConvexError({
        code: "INVALID_QUANTITY",
        min: MIN_QUANTITY,
        max: MAX_QUANTITY,
      });
    }

    const event = await ctx.db.get("events", args.eventId);
    if (event === null) {
      throw new ConvexError({ code: "EVENT_NOT_FOUND", eventId: args.eventId });
    }
    if (event.ticketsRemaining < args.quantity) {
      throw new ConvexError({
        code: "NOT_ENOUGH_TICKETS",
        ticketsRemaining: event.ticketsRemaining,
      });
    }

    await ctx.db.patch("events", args.eventId, {
      ticketsRemaining: event.ticketsRemaining - args.quantity,
    });
    return await ctx.db.insert("reservations", {
      eventId: args.eventId,
      quantity: args.quantity,
    });
  },
});

export const getEvent = query({
  args: {
    eventId: v.id("events"),
  },
  handler: async (ctx, args) => {
    const event = await ctx.db.get("events", args.eventId);
    if (event === null) {
      throw new ConvexError({ code: "EVENT_NOT_FOUND", eventId: args.eventId });
    }
    return { name: event.name, ticketsRemaining: event.ticketsRemaining };
  },
});
