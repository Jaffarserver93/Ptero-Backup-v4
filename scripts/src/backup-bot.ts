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
  previousTelegramMsgIds: number[];
}

function loadState(): BotState {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as Record<string, unknown>;
    // Migrate from the old single-ID format (previousTelegramMsgId: number | null)
    if (typeof raw["previousTelegramMsgId"] === "number") {
      return { previousTelegramMsgIds: [raw["previousTelegramMsgId"] as number] };
    }
    return { previousTelegramMsgIds: (raw["previousTelegramMsgIds"] as number[]) ?? [] };
  } catch {
    return { previousTelegramMsgIds: [] };
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

// ─── Resumable Part-Level Upload ─────────────────────────────────────────────
//
// Telegram's FLOOD_PREMIUM_WAIT throttles non-Premium upload speed.  The built-in
// client.uploadFile() restarts from part 0 on every error, so it can never make
// forward progress once flood-waits start hitting regularly.
//
// This function sends 512 KB parts one-by-one using the raw upload.saveBigFilePart
// TL call.  When FLOOD_PREMIUM_WAIT hits any part, we wait the required seconds and
// retry THAT SAME PART — so each retry moves the upload forward instead of backward.

const UPLOAD_PART_SIZE = 512 * 1024; // 512 KB — maximum allowed by Telegram

async function uploadFileResumable(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  filePath: string,
  fileName: string,
  onProgress: (done: number, total: number) => void,
): Promise<{ inputFile: { _: string; id: bigint; parts: number; name: string }; size: number; mime: string }> {
  const fileSize = fs.statSync(filePath).size;
  const totalParts = Math.ceil(fileSize / UPLOAD_PART_SIZE);

  // Random 64-bit file ID (Telegram requires a unique bigint per upload)
  const fileId =
    BigInt(Math.floor(Math.random() * 0x7fffffff)) * BigInt(0x100000000) +
    BigInt(Math.floor(Math.random() * 0xffffffff));

  log("telegram", `Resumable upload: ${totalParts} × 512 KB parts (flood waits auto-handled per-part)`);

  const fd = await fsp.open(filePath, "r");
  let bytesUploaded = 0;

  try {
    for (let partIdx = 0; partIdx < totalParts; partIdx++) {
      const offset = partIdx * UPLOAD_PART_SIZE;
      const bytesInPart = Math.min(UPLOAD_PART_SIZE, fileSize - offset);
      const buf = Buffer.allocUnsafe(bytesInPart);
      await fd.read(buf, 0, bytesInPart, offset);

      // Retry this single part on flood waits — never resets to part 0.
      while (true) {
        try {
          const ok = await client.call(
            {
              _: "upload.saveBigFilePart",
              fileId,
              filePart: partIdx,
              fileTotalParts: totalParts,
              bytes: buf,
            },
            { kind: "upload" },
          );
          if (!ok) throw new Error(`Server rejected part ${partIdx}`);
          break;
        } catch (partErr) {
          const floodSecs = parseFloodWaitSecs(partErr);
          if (floodSecs !== null) {
            const pct = Math.floor((partIdx / totalParts) * 100);
            const waitSecs = floodSecs + 5;
            log(
              "telegram",
              `  Part ${partIdx + 1}/${totalParts} (${pct}%) — FLOOD_WAIT ${floodSecs}s → resuming in ${waitSecs}s`,
            );
            await sleep(waitSecs * 1_000);
            // loop → retry exact same part
          } else {
            throw partErr;
          }
        }
      }

      bytesUploaded += bytesInPart;
      onProgress(bytesUploaded, fileSize);
    }
  } finally {
    await fd.close();
  }

  return {
    inputFile: { _: "inputFileBig", id: fileId, parts: totalParts, name: fileName },
    size: fileSize,
    mime: "application/gzip",
  };
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

      // 4. Upload to Telegram Saved Messages using resumable part-level upload.
      //    FLOOD_PREMIUM_WAIT is handled per-part — each flood wait pauses and
      //    retries the exact same part, so the upload always moves forward.
      const fileSize = fs.statSync(TMP_ARCHIVE).size;
      const totalSizeMB = (fileSize / 1024 / 1024).toFixed(2);
      const ts = new Date().toISOString();
      const fileName = `backup_${ts.replace(/[:.]/g, "-").replace("T", "_").slice(0, 19)}.tar.gz`;

      log("telegram", `Uploading ${totalSizeMB} MB to Saved Messages...`);
      const uploadStart = Date.now();
      let lastLoggedPct = -1;

      const uploaded = await uploadFileResumable(client, TMP_ARCHIVE, fileName, (done, total) => {
        const pct = Math.floor((done / total) * 100);
        if (pct >= lastLoggedPct + 10) {
          lastLoggedPct = pct;
          const elapsed = ((Date.now() - uploadStart) / 1000).toFixed(0);
          log("telegram", `  Upload ${pct}% (${(done / 1024 / 1024).toFixed(1)} / ${totalSizeMB} MB) [${elapsed}s]`);
        }
      });

      const sentMsg = await client.sendMedia("me", {
        type: "document",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        file: uploaded as any,
        fileName,
        caption: `🗄 *Pterodactyl Backup*\n📅 ${ts}\n💾 ${totalSizeMB} MB\n📦 ${folders.join(" + ")}`,
      });
      const sentMsgIds = [sentMsg.id];
      log("telegram", `✓ Upload done in ${((Date.now() - uploadStart) / 1000).toFixed(1)}s — msg ID ${sentMsg.id}`);

      // 5. Delete the previous backup messages from Saved Messages (keep exactly 1 set)
      if (state.previousTelegramMsgIds.length > 0) {
        try {
          await client.deleteMessagesById("me", state.previousTelegramMsgIds);
          log("telegram", `Deleted ${state.previousTelegramMsgIds.length} previous backup message(s)`);
        } catch (err) {
          log("telegram", `Could not delete old message(s): ${String(err)}`);
        }
      }

      // 6. Delete the archive from the panel
      await deleteArchiveFromServer(archiveName);
      archiveName = null; // mark cleaned up

      // 7. Clean up local temp file
      await fsp.rm(TMP_ARCHIVE, { force: true });

      // 8. Save state
      saveState({ previousTelegramMsgIds: sentMsgIds });

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

// Write to stdout immediately at module load time.
// This fires BEFORE main() and before any client/sqlite init.
// If you see this line but nothing after, the hang is inside main() (likely sqlite lock).
// If you DON'T see this line, tsx itself is hanging during import resolution.
process.stdout.write(`[${new Date().toISOString()}] [bot] Script loaded — entering main()\n`);

main().catch((err: unknown) => {
  console.error("[bot] Fatal:", err);
  process.exit(1);
});
