import type { GoogleAuth } from "./google-auth.ts";

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const DEFAULT_PAGE_SIZE = 2500;
const RETRY_DELAY_MS = 2000;

export interface EventDateTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface ExtendedProperties {
  private?: Record<string, string>;
  shared?: Record<string, string>;
}

export interface CalendarEvent {
  id: string;
  status: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  start: EventDateTime;
  end: EventDateTime;
  updated: string;
  htmlLink?: string;
  extendedProperties?: ExtendedProperties;
}

export interface EventCreateBody {
  summary: string;
  description?: string;
  start: EventDateTime;
  end: EventDateTime;
  extendedProperties?: ExtendedProperties;
  colorId?: string;
}

export type EventPatchBody = Partial<EventCreateBody>;

export interface ListParams {
  syncToken?: string;
  timeMin?: string;
  timeMax?: string;
  pageToken?: string;
  maxResults?: number;
}

export interface ListPage {
  events: CalendarEvent[];
  nextPageToken: string | null;
  nextSyncToken: string | null;
}

export class SyncTokenExpiredError extends Error {
  constructor(public readonly userEmail: string) {
    super(`google sync token expired (410 Gone) for user=${userEmail}`);
    this.name = "SyncTokenExpiredError";
  }
}

export interface CalendarClient {
  createEvent(userEmail: string, body: EventCreateBody): Promise<CalendarEvent>;
  patchEvent(
    userEmail: string,
    eventId: string,
    body: EventPatchBody,
  ): Promise<CalendarEvent>;
  deleteEvent(userEmail: string, eventId: string): Promise<void>;
  getEvent(userEmail: string, eventId: string): Promise<CalendarEvent | null>;
  findByNotionPageId(
    userEmail: string,
    notionPageId: string,
  ): Promise<CalendarEvent | null>;
  listPage(userEmail: string, params: ListParams): Promise<ListPage>;
  listAll(
    userEmail: string,
    params: ListParams,
  ): Promise<{ events: CalendarEvent[]; nextSyncToken: string | null }>;
}

export interface CalendarClientOptions {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function createCalendarClient(
  auth: GoogleAuth,
  options: CalendarClientOptions = {},
): CalendarClient {
  const fetchFn = options.fetchFn ?? fetch;
  const sleep = options.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function request(
    userEmail: string,
    method: string,
    path: string,
    opts: { body?: unknown; query?: Record<string, string | undefined> } = {},
  ): Promise<Response> {
    const token = await auth.getAccessToken(userEmail);
    const url = new URL(`${CALENDAR_BASE}${path}`);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, v);
      }
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
    };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const init: RequestInit = {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    };
    let res = await fetchFn(url, init);
    if (res.status === 429) {
      await sleep(RETRY_DELAY_MS);
      res = await fetchFn(url, init);
    }
    return res;
  }

  async function readError(res: Response): Promise<string> {
    try {
      return await res.text();
    } catch {
      return "";
    }
  }

  async function createEvent(
    userEmail: string,
    body: EventCreateBody,
  ): Promise<CalendarEvent> {
    const res = await request(userEmail, "POST", "/calendars/primary/events", {
      body,
    });
    if (!res.ok) {
      throw new Error(
        `calendar.createEvent failed for user=${userEmail}: ${res.status} ${await readError(res)}`,
      );
    }
    return (await res.json()) as CalendarEvent;
  }

  async function patchEvent(
    userEmail: string,
    eventId: string,
    body: EventPatchBody,
  ): Promise<CalendarEvent> {
    const res = await request(
      userEmail,
      "PATCH",
      `/calendars/primary/events/${encodeURIComponent(eventId)}`,
      { body },
    );
    if (!res.ok) {
      throw new Error(
        `calendar.patchEvent failed for user=${userEmail} event=${eventId}: ${res.status} ${await readError(res)}`,
      );
    }
    return (await res.json()) as CalendarEvent;
  }

  async function getEvent(
    userEmail: string,
    eventId: string,
  ): Promise<CalendarEvent | null> {
    const res = await request(
      userEmail,
      "GET",
      `/calendars/primary/events/${encodeURIComponent(eventId)}`,
    );
    // 404/410 mean the event is gone — surface as null so the caller can branch.
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) {
      throw new Error(
        `calendar.getEvent failed for user=${userEmail} event=${eventId}: ${res.status} ${await readError(res)}`,
      );
    }
    return (await res.json()) as CalendarEvent;
  }

  async function deleteEvent(userEmail: string, eventId: string): Promise<void> {
    const res = await request(
      userEmail,
      "DELETE",
      `/calendars/primary/events/${encodeURIComponent(eventId)}`,
    );
    // 404/410 mean the target is already gone — objective achieved (§8.11).
    if (res.status === 404 || res.status === 410) return;
    if (!res.ok) {
      throw new Error(
        `calendar.deleteEvent failed for user=${userEmail} event=${eventId}: ${res.status} ${await readError(res)}`,
      );
    }
  }

  async function findByNotionPageId(
    userEmail: string,
    notionPageId: string,
  ): Promise<CalendarEvent | null> {
    const res = await request(userEmail, "GET", "/calendars/primary/events", {
      query: {
        privateExtendedProperty: `notion_page_id=${notionPageId}`,
        maxResults: "1",
        singleEvents: "true",
        showDeleted: "false",
      },
    });
    if (!res.ok) {
      throw new Error(
        `calendar.findByNotionPageId failed for user=${userEmail} pageId=${notionPageId}: ${res.status} ${await readError(res)}`,
      );
    }
    const json = (await res.json()) as { items?: CalendarEvent[] };
    return json.items?.[0] ?? null;
  }

  async function listPage(
    userEmail: string,
    params: ListParams,
  ): Promise<ListPage> {
    const query: Record<string, string | undefined> = {
      singleEvents: "true",
      showDeleted: "true",
      maxResults: String(params.maxResults ?? DEFAULT_PAGE_SIZE),
      pageToken: params.pageToken,
    };
    if (params.syncToken) {
      query.syncToken = params.syncToken;
    } else {
      query.timeMin = params.timeMin;
      query.timeMax = params.timeMax;
    }
    const res = await request(userEmail, "GET", "/calendars/primary/events", {
      query,
    });
    if (res.status === 410) throw new SyncTokenExpiredError(userEmail);
    if (!res.ok) {
      throw new Error(
        `calendar.listPage failed for user=${userEmail}: ${res.status} ${await readError(res)}`,
      );
    }
    const json = (await res.json()) as {
      items?: CalendarEvent[];
      nextPageToken?: string;
      nextSyncToken?: string;
    };
    return {
      events: json.items ?? [],
      nextPageToken: json.nextPageToken ?? null,
      nextSyncToken: json.nextSyncToken ?? null,
    };
  }

  async function listAll(
    userEmail: string,
    params: ListParams,
  ): Promise<{ events: CalendarEvent[]; nextSyncToken: string | null }> {
    const collected: CalendarEvent[] = [];
    let pageToken: string | undefined = params.pageToken;
    let nextSyncToken: string | null = null;
    while (true) {
      const page = await listPage(userEmail, { ...params, pageToken });
      for (const e of page.events) collected.push(e);
      if (page.nextPageToken) {
        pageToken = page.nextPageToken;
        continue;
      }
      nextSyncToken = page.nextSyncToken;
      break;
    }
    return { events: collected, nextSyncToken };
  }

  return {
    createEvent,
    patchEvent,
    deleteEvent,
    getEvent,
    findByNotionPageId,
    listPage,
    listAll,
  };
}
