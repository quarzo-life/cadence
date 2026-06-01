// Temporary one-shot script — uploads /data/sync.db to transfer.sh and prints the URL.
// Usage: change Railway start command to this, deploy once, grab URL from logs, revert.
const path = Deno.env.get("DATABASE_PATH") ?? "/data/sync.db";
console.log(`uploading ${path} ...`);
const file = await Deno.readFile(path);
const res = await fetch("https://transfer.sh/sync.db", {
  method: "PUT",
  body: file,
  headers: { "Content-Type": "application/octet-stream" },
});
const url = await res.text();
console.log(`download URL: ${url.trim()}`);
