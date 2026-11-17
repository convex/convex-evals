import { beforeEach, expect, test } from "vitest";
import { ConvexClient } from "convex/browser";
import { ConvexError, type Value } from "convex/values";
import {
  addDocuments,
  cloudUrl,
  compareFunctionSpec,
  compareSchema,
  deleteAllDocuments,
  listTable,
  responseAdminClient,
  responseClient,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { Doc, Id } from "./answer/convex/_generated/dataModel";

const TABLES = ["checkoutFailures", "orders", "carts", "products"];

async function seedProducts(): Promise<{
  lamp: Id<"products">;
  rug: Id<"products">;
}> {
  await addDocuments(responseAdminClient, "products", [
    { name: "lamp", stock: 5 },
    { name: "rug", stock: 1 },
  ]);
  const products = (await listTable(
    responseAdminClient,
    "products",
  )) as Doc<"products">[];
  const id = (name: string) => products.find((p) => p.name === name)!._id;
  return { lamp: id("lamp"), rug: id("rug") };
}

async function createCart(
  items: { productId: Id<"products">; quantity: number }[],
): Promise<Id<"carts">> {
  const before = (await listTable(responseAdminClient, "carts")) as Doc<"carts">[];
  await addDocuments(responseAdminClient, "carts", [{ status: "open", items }]);
  const after = (await listTable(responseAdminClient, "carts")) as Doc<"carts">[];
  return after.find((cart) => !before.some((b) => b._id === cart._id))!._id;
}

async function stock(): Promise<Record<string, number>> {
  const products = (await listTable(
    responseAdminClient,
    "products",
  )) as Doc<"products">[];
  return Object.fromEntries(products.map((p) => [p.name, p.stock]));
}

async function cartStatus(cartId: Id<"carts">): Promise<string | undefined> {
  const carts = (await listTable(responseAdminClient, "carts")) as Doc<"carts">[];
  return carts.find((cart) => cart._id === cartId)?.status;
}

async function orders(): Promise<Doc<"orders">[]> {
  return (await listTable(responseAdminClient, "orders")) as Doc<"orders">[];
}

async function failures() {
  const rows = (await listTable(
    responseAdminClient,
    "checkoutFailures",
  )) as Doc<"checkoutFailures">[];
  return rows.map(({ cartId, code, productId }) => ({ cartId, code, productId }));
}

function checkout(cartId: Id<"carts">) {
  return responseClient.action(api.index.checkout, { cartId });
}

// The payload the client receives on the thrown error object.
async function failurePayload(call: Promise<unknown>): Promise<unknown> {
  const error: unknown = await call.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "expected checkout to fail").not.toBeNull();
  expect(error).toBeInstanceOf(ConvexError);
  return (error as ConvexError<Value>).data;
}

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, TABLES);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  // Only `checkout` is dictated; its internal mutations are not.
  await compareFunctionSpec(skip, { ignoreReturns: true, publicOnly: true });
});

test("places an order", async () => {
  const { lamp, rug } = await seedProducts();
  const cartId = await createCart([
    { productId: lamp, quantity: 2 },
    { productId: rug, quantity: 1 },
  ]);

  const orderId = await checkout(cartId);

  expect(await stock()).toEqual({ lamp: 3, rug: 0 });
  expect(await cartStatus(cartId)).toBe("ordered");
  const rows = await orders();
  expect(rows.map(({ _id, cartId }) => ({ _id, cartId }))).toEqual([
    { _id: orderId, cartId },
  ]);
  expect(await failures()).toEqual([]);
});

test("an out-of-stock item fails the whole checkout but the failure is recorded", async () => {
  const { lamp, rug } = await seedProducts();
  // The lamp line could be applied before the rug line is found short.
  const cartId = await createCart([
    { productId: lamp, quantity: 2 },
    { productId: rug, quantity: 3 },
  ]);

  expect(await failurePayload(checkout(cartId))).toEqual({
    code: "OUT_OF_STOCK",
    productId: rug,
  });

  expect(await stock()).toEqual({ lamp: 5, rug: 1 });
  expect(await cartStatus(cartId)).toBe("open");
  expect(await orders()).toEqual([]);
  expect(await failures()).toEqual([
    { cartId, code: "OUT_OF_STOCK", productId: rug },
  ]);
});

test("reports the first out-of-stock item in cart order", async () => {
  const { lamp, rug } = await seedProducts();
  await addDocuments(responseAdminClient, "products", [{ name: "vase", stock: 2 }]);
  const products = (await listTable(responseAdminClient, "products")) as Doc<"products">[];
  const vase = products.find((p) => p.name === "vase")!._id;
  // The rug line fits; the lamp and vase lines are both short.
  const cartId = await createCart([
    { productId: rug, quantity: 1 },
    { productId: lamp, quantity: 9 },
    { productId: vase, quantity: 5 },
  ]);

  expect(await failurePayload(checkout(cartId))).toEqual({
    code: "OUT_OF_STOCK",
    productId: lamp,
  });
  expect(await stock()).toEqual({ lamp: 5, rug: 1, vase: 2 });
  expect(await failures()).toEqual([
    { cartId, code: "OUT_OF_STOCK", productId: lamp },
  ]);
});

test("an already ordered cart is reported and recorded without changing anything", async () => {
  const { rug } = await seedProducts();
  const cartId = await createCart([{ productId: rug, quantity: 1 }]);
  await checkout(cartId);

  // The rug is now out of stock too; the status check comes first.
  expect(await failurePayload(checkout(cartId))).toEqual({
    code: "CART_ALREADY_ORDERED",
  });

  expect(await stock()).toEqual({ lamp: 5, rug: 0 });
  expect(await orders()).toHaveLength(1);
  expect(await failures()).toEqual([
    { cartId, code: "CART_ALREADY_ORDERED", productId: undefined },
  ]);
});

test("a missing cart is reported and recorded", async () => {
  const { lamp } = await seedProducts();
  const cartId = await createCart([{ productId: lamp, quantity: 1 }]);
  await deleteAllDocuments(responseAdminClient, ["carts"]);

  expect(await failurePayload(checkout(cartId))).toEqual({
    code: "CART_NOT_FOUND",
  });

  expect(await stock()).toEqual({ lamp: 5, rug: 1 });
  expect(await orders()).toEqual([]);
  expect(await failures()).toEqual([
    { cartId, code: "CART_NOT_FOUND", productId: undefined },
  ]);
});

test(
  "concurrent checkouts of one cart place a single order",
  { timeout: 30_000 },
  async () => {
    const { lamp } = await seedProducts();
    const cartId = await createCart([{ productId: lamp, quantity: 2 }]);

    // Separate connections, like separate devices.
    const devices = [0, 1, 2].map(() => new ConvexClient(cloudUrl));
    try {
      const outcomes = await Promise.allSettled(
        devices.map((device) => device.action(api.index.checkout, { cartId })),
      );

      const rejected = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      );
      expect(outcomes.length - rejected.length).toBe(1);
      for (const { reason } of rejected) {
        expect(reason).toBeInstanceOf(ConvexError);
        expect((reason as ConvexError<Value>).data).toEqual({
          code: "CART_ALREADY_ORDERED",
        });
      }
    } finally {
      await Promise.all(devices.map((device) => device.close()));
    }

    expect(await stock()).toEqual({ lamp: 3, rug: 1 });
    expect(await orders()).toHaveLength(1);
    expect(await failures()).toEqual([
      { cartId, code: "CART_ALREADY_ORDERED", productId: undefined },
      { cartId, code: "CART_ALREADY_ORDERED", productId: undefined },
    ]);
  },
);

test("every failed attempt is recorded once", async () => {
  const { rug } = await seedProducts();
  const cartId = await createCart([{ productId: rug, quantity: 2 }]);

  await failurePayload(checkout(cartId));
  await failurePayload(checkout(cartId));

  expect(await failures()).toEqual([
    { cartId, code: "OUT_OF_STOCK", productId: rug },
    { cartId, code: "OUT_OF_STOCK", productId: rug },
  ]);
  expect(await stock()).toEqual({ lamp: 5, rug: 1 });
});
