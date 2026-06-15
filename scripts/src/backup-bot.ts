import { TelegramClient, SqliteStorage } from "@mtcute/node";
import axios from "axios";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import { setTimeout as sleep } from "timers/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_ROOT = path.join(__dirname, "..");

// Suppress AbortSignal MaxListeners warning caused by mtcute's internal parallel connections
const originalEmit = process.emit.bind(process);
// @ts-ignore
process.emit = (event: string, ...args: unknown[]) => {
  if (event === "warning") {
    const w = args[0] as { name?: string; message?: string };
    if (w?.name === "MaxListenersExceededWarning") return false;
  }
  return originalEmit(event, ...args);
};

// ─── Load .env file if present (for terminal / start.sh runs) ─────────────────
try {
  const envPath = path.join(SCRIPTS_ROOT, ".env");
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key && !process.env[key]) process.env[key] = val;
  }
} catch { /* no .env file, fall back to system environment */ }

// ─── Config ───────────────────────────────────────────────────────────────────

const PTERO_URL = process.env["PTERODACTYL_URL"]?.replace(/\/$/, "");
const PTERO_KEY = process.env["PTERODACTYL_API_KEY"];
const SERVER_ID = process.env["PTERODACTYL_SERVER_ID"];
const TG_API_ID = process.env["TELEGRAM_API_ID"];
const TG_API_HASH = process.env["TELEGRAM_API_HASH"];
const TG_PHONE = process.env["TELEGRAM_PHONE"];

if (!PTERO_URL) throw new Error("PTERODACTYL_URL is required");
if (!PTERO_KEY) throw new Error("PTERODACTYL_API_KEY is required");
if (!SERVER_ID) throw new Error("PTERODACTYL_SERVER_ID is required");
if (!TG_API_ID) throw new Error("TELEGRAM_API_ID is required");
if (!TG_API_HASH) throw new Error("TELEGRAM_API_HASH is required");
if (!TG_PHONE) throw new Error("TELEGRAM_PHONE is required");

// Comma-separated folder names to back up — override via BACKUP_FOLDERS in .env
// e.g. BACKUP_FOLDERS=world,world_nether,world_the_end,plugins
const CONFIGURED_FOLDERS = (process.env["BACKUP_FOLDERS"] ?? "worlds,plugins")
  .split(",")
  .map(f => f.trim())
  .filter(Boolean);

const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const TMP_ARCHIVE = "/tmp/ptero_backup.tar.gz";
const SESSION_DB = path.join(SCRIPTS_ROOT, ".telegram_session.db");
const STATE_FILE = path.join(SCRIPTS_ROOT, ".bot_state.json");

// ─── State ────────────────────────────────────────────────────────────────────

interface BotState {
  previousTelegramMsgId: number | null;
}

function loadState(): BotState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as BotState;
  } catch {
    return { previousTelegramMsgId: null };
  }
}

function saveState(state: BotState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function log(tag: string, msg: string): void {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

// ─── Pterodactyl API ──────────────────────────────────────────────────────────

const ptero = axios.create({
  baseURL: `${PTERO_URL}/api/client`,
  headers: {
    Authorization: `Bearer ${PTERO_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  },
  timeout: 120_000,
});

async function ensureBackupDir(): Promise<void> {
  try {
    await ptero.get(`/servers/${SERVER_ID}/files/list?directory=/backups`);
  } catch {
    log("ptero", "Creating /backups directory...");
    await ptero.post(`/servers/${SERVER_ID}/files/create-folder`, {
      root: "/",
      name: "backups",
    });
  }
}

async function cleanupOrphanedArchives(): Promise<void> {
  // Delete leftover archive-*.tar.gz files in root from failed previous cycles
  try {
    const res = await ptero.get(`/servers/${SERVER_ID}/files/list?directory=/`);
    const files: Array<{ attributes: { name: string; is_file: boolean } }> =
      res.data?.data ?? [];
    const orphans = files
      .filter(f => f.attributes.is_file && /^archive-.+\.tar\.gz$/.test(f.attributes.name))
      .map(f => f.attributes.name);
    if (orphans.length > 0) {
      log("ptero", `Cleaning up ${orphans.length} orphaned root archive(s): ${orphans.join(", ")}`);
      await ptero.post(`/servers/${SERVER_ID}/files/delete`, { root: "/", files: orphans });
    }
  } catch (err) {
    log("ptero", `Could not clean up orphaned archives: ${String(err)}`);
  }
}

async function resolveBackupFolders(): Promise<string[]> {
  // List root dir and only compress folders that actually exist on the server
  const res = await ptero.get(`/servers/${SERVER_ID}/files/list?directory=/`);
  const entries: Array<{ attributes: { name: string; is_file: boolean } }> =
    res.data?.data ?? [];
  const existingNames = new Set(
    entries.filter(e => !e.attributes.is_file).map(e => e.attributes.name)
  );

  const found: string[] = [];
  const missing: string[] = [];
  for (const folder of CONFIGURED_FOLDERS) {
    if (existingNames.has(folder)) {
      found.push(folder);
    } else {
      missing.push(folder);
    }
  }

  if (missing.length > 0) {
    log("ptero", `WARNING: configured folder(s) not found on server: ${missing.join(", ")}`);
    log("ptero", `  → Available directories: ${[...existingNames].sort().join(", ")}`);
    log("ptero", `  → To fix: add BACKUP_FOLDERS=<comma list> to scripts/.env`);
  }

  if (found.length === 0) {
    throw new Error(
      `None of the configured folders exist on the server: ${CONFIGURED_FOLDERS.join(", ")}. ` +
      `Available: ${[...existingNames].sort().join(", ")}. ` +
      `Set BACKUP_FOLDERS in scripts/.env.`
    );
  }

  log("ptero", `Folders to compress: ${found.join(", ")}`);
  return found;
}

async function compressFolders(folders: string[]): Promise<string> {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  const archiveName = `backup_${timestamp}.tar.gz`;

  log("ptero", `Compressing ${folders.join(" + ")} → ${archiveName}...`);

  // Compress — the API response contains the actual filename the panel created
  const compressRes = await ptero.post(`/servers/${SERVER_ID}/files/compress`, {
    root: "/",
    files: folders,
  });

  // Read the real filename from the response (Pterodactyl names it archive-<ISO>.tar.gz)
  const createdName: string =
    compressRes.data?.attributes?.name ??
    compressRes.data?.name ??
    null;

  if (!createdName) {
    throw new Error(
      "Compress API did not return a filename. " +
      `Response: ${JSON.stringify(compressRes.data)}`
    );
  }

  log("ptero", `Panel created archive: ${createdName}`);
  log("ptero", `Moving ${createdName} → /backups/${archiveName}`);
  await ptero.put(`/servers/${SERVER_ID}/files/rename`, {
    root: "/",
    files: [{ from: createdName, to: `backups/${archiveName}` }],
  });

  log("ptero", `Archive ready at /backups/${archiveName}`);
  return archiveName;
}

async function getDownloadLink(archiveName: string): Promise<string> {
  const res = await ptero.get(
    `/servers/${SERVER_ID}/files/download?file=/backups/${archiveName}`
  );
  return res.data.attributes.url as string;
}

async function deleteArchiveFromServer(archiveName: string): Promise<void> {
  log("ptero", `Deleting /backups/${archiveName} from server...`);
  await ptero.post(`/servers/${SERVER_ID}/files/delete`, {
    root: "/backups",
    files: [archiveName],
  });
  log("ptero", "Archive deleted from panel");
}

// ─── File Download ────────────────────────────────────────────────────────────

async function downloadArchive(url: string): Promise<void> {
  log("download", "Downloading archive to temp storage...");
  await fsp.rm(TMP_ARCHIVE, { force: true });

  const response = await axios({
    method: "GET",
    url,
    responseType: "stream",
    maxRedirects: 10,
    timeout: 10 * 60_000,
  });

  const writer = fs.createWriteStream(TMP_ARCHIVE);
  (response.data as NodeJS.ReadableStream).pipe(writer);

  await new Promise<void>((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
    (response.data as NodeJS.ReadableStream).on("error", reject);
  });

  const sizeMB = (fs.statSync(TMP_ARCHIVE).size / 1024 / 1024).toFixed(2);
  log("download", `Done — ${sizeMB} MB`);
}

// ─── OTP / Auth ───────────────────────────────────────────────────────────────

const IS_INTERACTIVE = Boolean(process.stdin.isTTY);

async function readFromStdin(prompt: string): Promise<string> {
  if (!IS_INTERACTIVE) {
    throw new Error(
      "Cannot prompt for input in background mode. " +
      "Run `pnpm --filter @workspace/scripts run backup-bot` in the Shell tab first to complete login, then restart the workflow."
    );
  }
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(buf.slice(0, nl).trim());
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

// ─── Error helpers ────────────────────────────────────────────────────────────

function parseFloodWaitSecs(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  // Matches FLOOD_WAIT_42, FLOOD_PREMIUM_WAIT5, FLOOD_PREMIUM_WAIT_5, etc.
  const m = msg.match(/FLOOD_(?:PREMIUM_)?WAIT_?(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log("bot", "Pterodactyl → Telegram backup bot starting...");
  log("bot", `Configured folders: ${CONFIGURED_FOLDERS.join(", ")}`);

  const client = new TelegramClient({
    apiId: parseInt(TG_API_ID!),
    apiHash: TG_API_HASH!,
    storage: new SqliteStorage(SESSION_DB),
  });

  log("telegram", "Connecting to Telegram...");

  await client.start({
    phone: TG_PHONE,
    code: async () => {
      log("telegram", "Telegram sent a login code to your phone/app.");
      return readFromStdin("  Enter the Telegram OTP code: ");
    },
    password: async () => {
      return readFromStdin("  Enter your 2FA password (if any): ");
    },
  });

  log("telegram", "Logged in successfully — session saved to .telegram_session.db");

  try {
    const startMsg = await client.sendText("me",
      `🟢 *Backup Bot Online*\n📅 ${new Date().toISOString()}\n⏱ Backing up: ${CONFIGURED_FOLDERS.join(" + ")} every 5 min`
    );
    log("telegram", "Startup message sent to Saved Messages (auto-deletes in 30s)");
    sleep(30_000).then(async () => {
      try {
        await client.deleteMessagesById("me", [startMsg.id]);
        log("telegram", "Startup message deleted");
      } catch { /* ignore */ }
    });
  } catch (err) {
    log("telegram", `Could not send startup message: ${String(err)}`);
  }

  await ensureBackupDir();
  log("bot", `Ready — first backup will run in 5 minutes`);

  // Wait the first full interval before cycling
  await sleep(INTERVAL_MS);

  while (true) {
    const cycleStart = Date.now();
    const state = loadState();
    let archiveName: string | null = null;

    try {
      // 0. Clean up orphaned archives in root from previous failed cycles
      await cleanupOrphanedArchives();

      // 1. Verify which configured folders actually exist on the server
      const folders = await resolveBackupFolders();

      // 2. Compress the verified folders into one archive
      archiveName = await compressFolders(folders);

      // Wait for Wings to finish writing before requesting a download link
      log("ptero", "Waiting 5s for archive to be ready on Wings...");
      await sleep(5_000);

      // 3. Get download URL — retry up to 3× on 500
      let downloadUrl = "";
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          downloadUrl = await getDownloadLink(archiveName);
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (attempt < 3) {
            log("ptero", `Download link attempt ${attempt} failed (${msg}) — retrying in 10s...`);
            await sleep(10_000);
          } else {
            throw new Error(`Failed to get download link after 3 attempts: ${msg}`);
          }
        }
      }
      await downloadArchive(downloadUrl);

      // 4. Upload to Telegram Saved Messages (supports up to 2 GB via MTProto)
      //    Retries up to MAX_UPLOAD_ATTEMPTS times, respecting FLOOD_PREMIUM_WAIT
      //    between attempts. The temp file is kept alive across retries so we never
      //    have to re-download the archive from the panel.
      const fileSize = fs.statSync(TMP_ARCHIVE).size;
      const sizeMB = (fileSize / 1024 / 1024).toFixed(2);
      const ts = new Date().toISOString();
      const fileName = `backup_${ts.replace(/[:.]/g, "-").replace("T", "_").slice(0, 19)}.tar.gz`;

      const MAX_UPLOAD_ATTEMPTS = 5;
      let sentMsg: Awaited<ReturnType<typeof client.sendMedia>> | null = null;

      for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
        try {
          log("telegram", `Uploading ${sizeMB} MB to Saved Messages... (attempt ${attempt}/${MAX_UPLOAD_ATTEMPTS})`);
          const uploadStart = Date.now();

          let lastLoggedPct = -1;
          const uploaded = await client.uploadFile({
            file: TMP_ARCHIVE,
            fileName,
            // 1 request in flight at a time + small 128 KB parts = the most
            // conservative upload mode available to avoid FLOOD_PREMIUM_WAIT
            // for non-Premium accounts uploading large files.
            requestsPerConnection: 1,
            partSize: 128,
            progressCallback: (done, total) => {
              const pct = Math.floor((done / total) * 100);
              if (pct >= lastLoggedPct + 10) {
                lastLoggedPct = pct;
                const elapsed = ((Date.now() - uploadStart) / 1000).toFixed(0);
                log("telegram", `  Uploading... ${pct}% (${(done / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB) [${elapsed}s]`);
              }
            },
          });

          sentMsg = await client.sendMedia("me", {
            type: "document",
            file: uploaded,
            fileName,
            caption: `🗄 *Pterodactyl Backup*\n📅 ${ts}\n💾 ${sizeMB} MB\n📦 ${folders.join(" + ")}`,
          });
          log("telegram", `✓ Upload + send done in ${((Date.now() - uploadStart) / 1000).toFixed(1)}s — msg ID ${sentMsg.id}`);
          break; // success — exit retry loop

        } catch (uploadErr) {
          const floodSecs = parseFloodWaitSecs(uploadErr);
          if (floodSecs !== null && attempt < MAX_UPLOAD_ATTEMPTS) {
            // Telegram flood-wait: pause for the required duration + a safety buffer,
            // then retry without re-downloading the archive.
            const waitSecs = floodSecs + 15;
            log("telegram", `FLOOD_PREMIUM_WAIT ${floodSecs}s on attempt ${attempt} — waiting ${waitSecs}s before retry...`);
            await sleep(waitSecs * 1_000);
            continue;
          }
          // Non-flood error, or flood on the final attempt — propagate to cycle handler
          throw uploadErr;
        }
      }

      if (!sentMsg) throw new Error("Upload loop exited without sending a message");

      // 5. Delete the previous backup from Saved Messages (keep exactly 1)
      if (state.previousTelegramMsgId) {
        try {
          await client.deleteMessagesById("me", [state.previousTelegramMsgId]);
          log("telegram", `Deleted previous backup message ${state.previousTelegramMsgId}`);
        } catch (err) {
          log("telegram", `Could not delete old message: ${String(err)}`);
        }
      }

      // 6. Delete the archive from the panel
      await deleteArchiveFromServer(archiveName);
      archiveName = null; // mark cleaned up

      // 7. Clean up local temp file
      await fsp.rm(TMP_ARCHIVE, { force: true });

      // 8. Save state
      saveState({ previousTelegramMsgId: sentMsg.id });

      const elapsed = Date.now() - cycleStart;
      const waitMs = Math.max(0, INTERVAL_MS - elapsed);
      log("bot", `✓ Cycle done in ${(elapsed / 1000).toFixed(1)}s — next backup in ${Math.ceil(waitMs / 1000)}s`);
      await sleep(waitMs);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("bot", `✗ Cycle error: ${msg}`);

      // Clean up the archive from /backups if it was already moved there
      if (archiveName) {
        try {
          await deleteArchiveFromServer(archiveName);
          log("ptero", `Cleaned up failed-cycle archive: ${archiveName}`);
        } catch { /* ignore cleanup errors */ }
        await fsp.rm(TMP_ARCHIVE, { force: true }).catch(() => {});
      }

      // Always wait out the remainder of the full 5-minute interval before retrying.
      // For Telegram flood-wait errors, also enforce the required minimum wait.
      const floodSecs = parseFloodWaitSecs(err);
      const elapsed = Date.now() - cycleStart;
      let waitMs = Math.max(30_000, INTERVAL_MS - elapsed);
      if (floodSecs !== null) {
        const floodMs = (floodSecs + 10) * 1_000;
        waitMs = Math.max(waitMs, floodMs);
        log("telegram", `Flood wait ${floodSecs}s — next cycle in ${Math.ceil(waitMs / 1000)}s`);
      } else {
        log("bot", `Retrying in ${Math.ceil(waitMs / 1000)}s`);
      }
      await sleep(waitMs);
    }
  }
}

main().catch((err: unknown) => {
  console.error("[bot] Fatal:", err);
  process.exit(1);
});
