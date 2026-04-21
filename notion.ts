import { Client as NotionClient } from "@notionhq/client";

// Subset of the Notion page shape we actually read. The SDK exposes deeply
// discriminated unions that are painful at the boundary; typing only the
// fields we use keeps the parser auditable.

interface RawNotionPage {
  id: string;
  archived?: boolean;
  last_edited_time: string;
  url: string;
  properties: Record<string, RawProperty | undefined>;
}

interface RawRichText {
  plain_text?: string;
}

interface RawDateValue {
  start: string;
  end: string | null;
  time_zone: string | null;
}

interface RawPerson {
  id: string;
  name?: string | null;
  person?: { email?: string | null };
}

type RawProperty =
  | { type: "title"; title: RawRichText[] }
  | { type: "date"; date: RawDateValue | null }
  | { type: "people"; people: RawPerson[] }
  | { type: "status"; status: { name: string } | null }
  | { type: "select"; select: { name: string } | null };

export interface NotionTask {
  pageId: string;
  title: string;
  dateStart: string;
  dateEnd: string | null;
  isAllDay: boolean;
  ownerEmail: string | null;
  ownerName: string | null;
  statusValue: string | null;
  lastEditedAt: string;
  url: string;
  isArchived: boolean;
}

export interface NotionUser {
  id: string;
  name: string | null;
  email: string | null;
}

export interface NotionSchemaConfig {
  propTitle: string;
  propDate: string;
  propOwner: string;
  propStatus: string | null;
  statusArchivedValues: string[];
}

export interface NotionServiceConfig {
  databaseId: string;
  schema: NotionSchemaConfig;
}

export interface CreateTaskArgs {
  title: string;
  dateStart: string;
  dateEnd: string | null;
  isAllDay: boolean;
  ownerUserId: string;
  timezone: string;
}

export interface UpdateTaskArgs {
  pageId: string;
  title: string;
  dateStart: string;
  dateEnd: string | null;
  isAllDay: boolean;
  timezone: string;
}

export interface NotionService {
  queryTasksSince(sinceIso: string): Promise<NotionTask[]>;
  queryAllTasks(): Promise<NotionTask[]>;
  createTaskPage(args: CreateTaskArgs): Promise<{ pageId: string; lastEditedAt: string }>;
  updateTaskPage(args: UpdateTaskArgs): Promise<{ lastEditedAt: string }>;
  archiveTaskPage(pageId: string): Promise<void>;
  listUsers(): Promise<NotionUser[]>;
}

export function parseNotionPage(
  rawPage: unknown,
  schema: NotionSchemaConfig,
): NotionTask | null {
  const page = rawPage as RawNotionPage | null;
  if (!page || !page.properties) return null;
  const props = page.properties;

  const dateProp = props[schema.propDate];
  const dateValue = dateProp && dateProp.type === "date" ? dateProp.date : null;
  if (!dateValue || !dateValue.start) return null;

  const titleProp = props[schema.propTitle];
  const title = titleProp && titleProp.type === "title"
    ? titleProp.title.map((t) => t.plain_text ?? "").join("")
    : "";

  const ownerProp = props[schema.propOwner];
  const people = ownerProp && ownerProp.type === "people" ? ownerProp.people : [];
  const firstPerson = people[0];
  const ownerEmail = firstPerson?.person?.email ?? null;
  const ownerName = firstPerson?.name ?? null;

  let statusValue: string | null = null;
  if (schema.propStatus) {
    const s = props[schema.propStatus];
    if (s && s.type === "status") statusValue = s.status?.name ?? null;
    else if (s && s.type === "select") statusValue = s.select?.name ?? null;
  }

  const dateStart = dateValue.start;
  const dateEnd = dateValue.end;
  const isAllDay = !dateStart.includes("T");

  const pageArchived = Boolean(page.archived);
  const statusArchived = statusValue !== null &&
    schema.statusArchivedValues.some((v) => v === statusValue);

  return {
    pageId: page.id,
    title,
    dateStart,
    dateEnd,
    isAllDay,
    ownerEmail,
    ownerName,
    statusValue,
    lastEditedAt: page.last_edited_time,
    url: page.url,
    isArchived: pageArchived || statusArchived,
  };
}

export function buildDateProperty(
  dateStart: string,
  dateEnd: string | null,
  isAllDay: boolean,
  timezone: string,
): { date: { start: string; end: string | null; time_zone: string | null } } {
  return {
    date: {
      start: dateStart,
      end: dateEnd,
      time_zone: isAllDay ? null : timezone,
    },
  };
}

export function buildTitleProperty(title: string): {
  title: Array<{ type: "text"; text: { content: string } }>;
} {
  return { title: [{ type: "text", text: { content: title } }] };
}

export function createNotionService(
  client: NotionClient,
  cfg: NotionServiceConfig,
): NotionService {
  const dateIsNotEmpty = {
    property: cfg.schema.propDate,
    date: { is_not_empty: true },
  };

  async function queryWithFilter(filter: unknown): Promise<NotionTask[]> {
    const out: NotionTask[] = [];
    let cursor: string | undefined;
    do {
      // Notion SDK types for databases.query are narrow and require casts at
      // the boundary — we pass our raw filter object through.
      const res = await client.databases.query({
        database_id: cfg.databaseId,
        filter: filter as never,
        start_cursor: cursor,
        page_size: 100,
      }) as { results: unknown[]; has_more: boolean; next_cursor: string | null };

      for (const raw of res.results) {
        const task = parseNotionPage(raw, cfg.schema);
        if (task) out.push(task);
      }
      cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
    } while (cursor);
    return out;
  }

  async function queryTasksSince(sinceIso: string): Promise<NotionTask[]> {
    return await queryWithFilter({
      and: [
        {
          timestamp: "last_edited_time",
          last_edited_time: { on_or_after: sinceIso },
        },
        dateIsNotEmpty,
      ],
    });
  }

  async function queryAllTasks(): Promise<NotionTask[]> {
    return await queryWithFilter(dateIsNotEmpty);
  }

  async function createTaskPage(
    args: CreateTaskArgs,
  ): Promise<{ pageId: string; lastEditedAt: string }> {
    const properties = {
      [cfg.schema.propTitle]: buildTitleProperty(args.title),
      [cfg.schema.propDate]: buildDateProperty(
        args.dateStart,
        args.dateEnd,
        args.isAllDay,
        args.timezone,
      ),
      [cfg.schema.propOwner]: { people: [{ id: args.ownerUserId }] },
    };
    const res = await client.pages.create({
      parent: { database_id: cfg.databaseId },
      properties: properties as never,
    }) as { id: string; last_edited_time: string };
    return { pageId: res.id, lastEditedAt: res.last_edited_time };
  }

  async function updateTaskPage(
    args: UpdateTaskArgs,
  ): Promise<{ lastEditedAt: string }> {
    const properties = {
      [cfg.schema.propTitle]: buildTitleProperty(args.title),
      [cfg.schema.propDate]: buildDateProperty(
        args.dateStart,
        args.dateEnd,
        args.isAllDay,
        args.timezone,
      ),
    };
    const res = await client.pages.update({
      page_id: args.pageId,
      properties: properties as never,
    }) as { last_edited_time: string };
    return { lastEditedAt: res.last_edited_time };
  }

  async function archiveTaskPage(pageId: string): Promise<void> {
    await client.pages.update({ page_id: pageId, archived: true });
  }

  async function listUsers(): Promise<NotionUser[]> {
    const out: NotionUser[] = [];
    let cursor: string | undefined;
    do {
      const res = await client.users.list({
        start_cursor: cursor,
        page_size: 100,
      }) as {
        results: Array<{
          id: string;
          name?: string | null;
          type?: string;
          person?: { email?: string | null };
        }>;
        has_more: boolean;
        next_cursor: string | null;
      };
      for (const u of res.results) {
        if (u.type !== "person") continue;
        out.push({
          id: u.id,
          name: u.name ?? null,
          email: u.person?.email ?? null,
        });
      }
      cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
    } while (cursor);
    return out;
  }

  return {
    queryTasksSince,
    queryAllTasks,
    createTaskPage,
    updateTaskPage,
    archiveTaskPage,
    listUsers,
  };
}
