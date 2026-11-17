import { beforeEach, expect, test } from "vitest";
import { ConvexError, type Value } from "convex/values";
import {
  addDocuments,
  compareFunctionSpec,
  compareSchema,
  deleteAllDocuments,
  listTable,
  responseAdminClient,
  responseClient,
} from "../../../grader";
import { api } from "./answer/convex/_generated/api";
import { Doc, Id } from "./answer/convex/_generated/dataModel";

async function createEvent(
  name: string,
  ticketsRemaining: number,
): Promise<Id<"events">> {
  await addDocuments(responseAdminClient, "events", [{ name, ticketsRemaining }]);
  const events = (await listTable(responseAdminClient, "events")) as Doc<"events">[];
  return events.find((event) => event.name === name)!._id;
}

async function deletedEventId(): Promise<Id<"events">> {
  const eventId = await createEvent("Cancelled", 10);
  await deleteAllDocuments(responseAdminClient, ["events"]);
  return eventId;
}

async function ticketsRemaining(eventId: Id<"events">): Promise<number> {
  const events = (await listTable(responseAdminClient, "events")) as Doc<"events">[];
  return events.find((event) => event._id === eventId)!.ticketsRemaining;
}

async function reservations(): Promise<Doc<"reservations">[]> {
  return (await listTable(
    responseAdminClient,
    "reservations",
  )) as Doc<"reservations">[];
}

// The payload the client receives on the thrown error object.
async function failurePayload(call: Promise<unknown>): Promise<unknown> {
  const error: unknown = await call.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, "expected the call to fail").not.toBeNull();
  expect(error).toBeInstanceOf(ConvexError);
  return (error as ConvexError<Value>).data;
}

function reserve(eventId: Id<"events">, quantity: number) {
  return responseClient.mutation(api.index.reserveTickets, { eventId, quantity });
}

beforeEach(async () => {
  await deleteAllDocuments(responseAdminClient, ["reservations", "events"]);
});

test("compare schema", async ({ skip }) => {
  await compareSchema(skip);
});

test("compare function spec", async ({ skip }) => {
  await compareFunctionSpec(skip, { ignoreReturns: true, publicOnly: true });
});

test("reserves tickets", async () => {
  const eventId = await createEvent("Concert", 5);

  const reservationId = await reserve(eventId, 2);

  expect(await ticketsRemaining(eventId)).toBe(3);
  const rows = await reservations();
  expect(rows.map(({ _id, eventId, quantity }) => ({ _id, eventId, quantity }))).toEqual([
    { _id: reservationId, eventId, quantity: 2 },
  ]);
});

test("rejects quantities outside 1 to 10 with INVALID_QUANTITY", async () => {
  const eventId = await createEvent("Concert", 50);

  for (const quantity of [0, 11, -1, 2.5]) {
    expect(await failurePayload(reserve(eventId, quantity))).toEqual({
      code: "INVALID_QUANTITY",
      min: 1,
      max: 10,
    });
  }
  expect(await ticketsRemaining(eventId)).toBe(50);
  expect(await reservations()).toEqual([]);
});

test("reports a missing event with EVENT_NOT_FOUND and its ID", async () => {
  const eventId = await deletedEventId();

  expect(await failurePayload(reserve(eventId, 1))).toEqual({
    code: "EVENT_NOT_FOUND",
    eventId,
  });
  expect(await reservations()).toEqual([]);
});

test("checks the quantity before the event", async () => {
  const eventId = await deletedEventId();

  expect(await failurePayload(reserve(eventId, 0))).toEqual({
    code: "INVALID_QUANTITY",
    min: 1,
    max: 10,
  });
});

test("reports NOT_ENOUGH_TICKETS with the current count and changes nothing", async () => {
  const eventId = await createEvent("Theatre", 3);

  expect(await failurePayload(reserve(eventId, 4))).toEqual({
    code: "NOT_ENOUGH_TICKETS",
    ticketsRemaining: 3,
  });
  expect(await ticketsRemaining(eventId)).toBe(3);
  expect(await reservations()).toEqual([]);
});

test("the last tickets can be reserved, and then the event is sold out", async () => {
  const eventId = await createEvent("Gig", 3);

  await reserve(eventId, 3);

  expect(await ticketsRemaining(eventId)).toBe(0);
  expect(await failurePayload(reserve(eventId, 1))).toEqual({
    code: "NOT_ENOUGH_TICKETS",
    ticketsRemaining: 0,
  });
  expect(await reservations()).toHaveLength(1);
});

test("getEvent returns the event", async () => {
  const eventId = await createEvent("Festival", 120);

  expect(await responseClient.query(api.index.getEvent, { eventId })).toMatchObject({
    name: "Festival",
    ticketsRemaining: 120,
  });
});

test("getEvent reports a missing event with EVENT_NOT_FOUND and its ID", async () => {
  const eventId = await deletedEventId();

  expect(
    await failurePayload(responseClient.query(api.index.getEvent, { eventId })),
  ).toEqual({ code: "EVENT_NOT_FOUND", eventId });
});
