import { expect, test, beforeEach } from "vitest";
import {
  deleteAllDocuments,
  getSchema,
  listTable,
  responseAdminClient,
  responseClient,
  readOutputFile,
} from "../../../grader";
import { collectsTicketsTable } from "./collectCheck";
import { anyApi } from "convex/server";

beforeEach(async () => {
  const schema = await getSchema(responseAdminClient);
  if (schema && Array.isArray(schema.tables)) {
    const tableNames = schema.tables.map((t: any) => t.tableName);
    await deleteAllDocuments(responseAdminClient, tableNames);
  }
});

test("getTicketCount returns 0 for an org with no tickets", async () => {
  const count = await responseClient.query(
    anyApi.index.getTicketCount,
    { orgId: "org-1" },
  );

  expect(count).toBe(0);
});

test("getTicketCount returns the correct count after creating tickets", async () => {
  await responseClient.mutation(anyApi.index.createTicket, {
    orgId: "org-1",
    title: "Fix login bug",
    status: "open",
  });
  await responseClient.mutation(anyApi.index.createTicket, {
    orgId: "org-1",
    title: "Add dark mode",
    status: "open",
  });
  await responseClient.mutation(anyApi.index.createTicket, {
    orgId: "org-1",
    title: "Update docs",
    status: "closed",
  });

  const count = await responseClient.query(
    anyApi.index.getTicketCount,
    { orgId: "org-1" },
  );

  expect(count).toBe(3);
});

test("createTicket stores the ticket", async () => {
  await responseClient.mutation(anyApi.index.createTicket, {
    orgId: "org-1",
    title: "Fix login bug",
    status: "open",
  });

  const tickets = (await listTable(responseAdminClient, "tickets")) as {
    orgId: string;
    title: string;
    status: string;
  }[];
  expect(
    tickets.map(({ orgId, title, status }) => ({ orgId, title, status })),
  ).toEqual([{ orgId: "org-1", title: "Fix login bug", status: "open" }]);
});

test("getTicketCount returns independent counts per org", async () => {
  await responseClient.mutation(anyApi.index.createTicket, {
    orgId: "org-1",
    title: "Ticket A",
    status: "open",
  });
  await responseClient.mutation(anyApi.index.createTicket, {
    orgId: "org-1",
    title: "Ticket B",
    status: "open",
  });
  await responseClient.mutation(anyApi.index.createTicket, {
    orgId: "org-2",
    title: "Ticket C",
    status: "open",
  });

  const countOrg1 = await responseClient.query(
    anyApi.index.getTicketCount,
    { orgId: "org-1" },
  );
  const countOrg2 = await responseClient.query(
    anyApi.index.getTicketCount,
    { orgId: "org-2" },
  );
  const countOrg3 = await responseClient.query(
    anyApi.index.getTicketCount,
    { orgId: "org-3" },
  );

  expect(countOrg1).toBe(2);
  expect(countOrg2).toBe(1);
  expect(countOrg3).toBe(0);
});

test("generated solution does not .collect() the tickets table in convex/index.ts", () => {
  const sourceText = readOutputFile(
    "002-queries",
    "023-count_without_collect",
    "convex/index.ts",
  );
  expect(collectsTicketsTable(sourceText)).toBe(false);
});
