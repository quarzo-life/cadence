export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  notion: {
    token: string;
    databaseId: string;
    propTitle: string;
    propDate: string;
    propOwner: string;
    propStatus: string | null;
    statusArchivedValues: string[];
  };
  google: {
    saEmail: string;
    saPrivateKey: string;
    watchEmails: string[];
    syncKeyword: string;
  };
  sync: {
    defaultEventDurationMin: number;
    lookbackMin: number;
    timezone: string;
    reconcileIntervalHours: number;
  };
  database: {
    path: string;
  };
  logLevel: LogLevel;
}

export function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function parseLogLevel(value: string): LogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  throw new Error(`invalid LOG_LEVEL: "${value}" (expected debug|info|warn|error)`);
}

export function parsePositiveInt(key: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`invalid ${key}: "${raw}" (expected non-negative integer)`);
  }
  return n;
}

function requiredEnv(key: string): string {
  const v = Deno.env.get(key);
  if (!v || v.length === 0) {
    throw new Error(`missing required env var: ${key}`);
  }
  return v;
}

function optionalEnv(key: string, fallback: string): string {
  const v = Deno.env.get(key);
  return v === undefined || v === "" ? fallback : v;
}

function optionalEnvOrNull(key: string): string | null {
  const v = Deno.env.get(key);
  return v === undefined || v === "" ? null : v;
}

// Railway stores PEM newlines as literal "\n" sequences — restore real newlines
// before the key hits Web Crypto's PKCS8 importer.
function normalizePrivateKey(raw: string): string {
  return raw.replace(/\\n/g, "\n");
}

export function loadConfig(): Config {
  return {
    notion: {
      token: requiredEnv("NOTION_TOKEN"),
      databaseId: requiredEnv("NOTION_DATABASE_ID"),
      propTitle: optionalEnv("NOTION_PROP_TITLE", "Name"),
      propDate: optionalEnv("NOTION_PROP_DATE", "Date"),
      propOwner: optionalEnv("NOTION_PROP_OWNER", "Owner"),
      propStatus: optionalEnvOrNull("NOTION_PROP_STATUS"),
      statusArchivedValues: parseCsv(
        optionalEnv("NOTION_STATUS_ARCHIVED_VALUES", "Archived,Done,Cancelled"),
      ),
    },
    google: {
      saEmail: requiredEnv("GOOGLE_SA_EMAIL"),
      saPrivateKey: normalizePrivateKey(requiredEnv("GOOGLE_SA_PRIVATE_KEY")),
      watchEmails: parseCsv(optionalEnv("GOOGLE_WATCH_EMAILS", "")),
      syncKeyword: optionalEnv("GOOGLE_SYNC_KEYWORD", "NOTION"),
    },
    sync: {
      defaultEventDurationMin: parsePositiveInt(
        "DEFAULT_EVENT_DURATION_MIN",
        Deno.env.get("DEFAULT_EVENT_DURATION_MIN"),
        30,
      ),
      lookbackMin: parsePositiveInt(
        "SYNC_LOOKBACK_MIN",
        Deno.env.get("SYNC_LOOKBACK_MIN"),
        15,
      ),
      timezone: optionalEnv("SYNC_TIMEZONE", "Europe/Paris"),
      reconcileIntervalHours: parsePositiveInt(
        "RECONCILE_INTERVAL_HOURS",
        Deno.env.get("RECONCILE_INTERVAL_HOURS"),
        24,
      ),
    },
    database: {
      path: optionalEnv("DATABASE_PATH", "/data/sync.db"),
    },
    logLevel: parseLogLevel(optionalEnv("LOG_LEVEL", "info")),
  };
}
