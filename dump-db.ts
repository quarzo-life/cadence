// Temporary one-shot script — serves /data/sync.db over HTTP for one download.
// Usage: change Railway start command to this, deploy once, download, revert.
const path = Deno.env.get("DATABASE_PATH") ?? "/data/sync.db";
const port = Number(Deno.env.get("PORT") ?? 8080);
console.log(`serving ${path} on port ${port} — download once then revert start command`);

Deno.serve({ port }, async (_req) => {
  const file = await Deno.readFile(path);
  return new Response(file, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": 'attachment; filename="sync.db"',
      "Content-Length": String(file.byteLength),
    },
  });
});
