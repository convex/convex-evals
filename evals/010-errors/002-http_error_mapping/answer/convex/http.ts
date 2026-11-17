import { httpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";

const http = httpRouter();

// HTTP status for each application error code thrown by placeOrder.
const STATUS_BY_CODE: Record<string, number> = {
  INVALID_QUANTITY: 400,
  PRODUCT_NOT_FOUND: 404,
  OUT_OF_STOCK: 409,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

http.route({
  path: "/orders",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(400, { error: { code: "INVALID_REQUEST" } });
    }
    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as { sku?: unknown }).sku !== "string" ||
      typeof (body as { quantity?: unknown }).quantity !== "number"
    ) {
      return json(400, { error: { code: "INVALID_REQUEST" } });
    }
    const { sku, quantity } = body as { sku: string; quantity: number };

    try {
      const orderId = await ctx.runMutation(api.index.placeOrder, {
        sku,
        quantity,
      });
      return json(201, { orderId });
    } catch (error) {
      // ConvexError keeps its data across ctx.runMutation, so the code can be
      // mapped to a status. Anything else is unexpected and stays a 500.
      if (error instanceof ConvexError) {
        const data = error.data as { code: string };
        const status = STATUS_BY_CODE[data.code];
        if (status !== undefined) {
          return json(status, { error: data });
        }
      }
      throw error;
    }
  }),
});

export default http;
