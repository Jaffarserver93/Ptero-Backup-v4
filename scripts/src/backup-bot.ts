import { TelegramClient, SqliteStorage } from "@mtcute/node";
import axios from "axios";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import { setTimeout as sleep } from "timers/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_ROOT = path.join(__dirname, "..");

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

const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const FOLDERS = ["worlds", "plugins"];
const BACKUP_ZIP_NAME = "worlds_plugins_backup.zip";
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

async function compressFolders(): Promise<string> {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  const archiveName = `backup_${timestamp}.tar.gz`;

  log("ptero", `Compressing ${FOLDERS.join(" + ")} into ${archiveName}...`);

  // Compress both folders together into one archive
  await ptero.post(`/servers/${SERVER_ID}/files/compress`, {
    root: "/",
    files: FOLDERS,
  });

  // The panel names it after the first folder or a combined name — rename it
  // The panel creates <first_folder>.tar.gz when multiple files are compressed
  const srcName = `${FOLDERS[0]}.tar.gz`;
  const destPath = `backups/${archiveName}`;

  log("ptero", `Moving ${srcName} → /backups/${archiveName}`);
  await ptero.put(`/servers/${SERVER_ID}/files/rename`, {
    root: "/",
    files: [{ from: srcName, to: destPath }],
  });

  log("ptero", `Archive ready at /backups/${archiveName}`);
  return archiveName;
}

async function getDownloadLink(archiveName: string): Promise<string> {
  // Get a signed download URL for the file
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log("bot", "Pterodactyl → Telegram backup bot starting...");

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

  // Send a startup notice to Saved Messages then auto-delete it
  try {
    const startMsg = await client.sendText("me", 
      `🟢 *Backup Bot Online*\n📅 ${new Date().toISOString()}\n⏱ Backing up: worlds + plugins every 5 min`
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

    try {
      // 1. Compress worlds + plugins into one archive on the panel
      const archiveName = await compressFolders();

      // 2. Get download URL and pull it to temp storage here
      const downloadUrl = await getDownloadLink(archiveName);
      await downloadArchive(downloadUrl);

      // 3. Upload to Telegram Saved Messages
      const sizeMB = (fs.statSync(TMP_ARCHIVE).size / 1024 / 1024).toFixed(2);
      const ts = new Date().toISOString();
      log("telegram", `Uploading ${sizeMB} MB to Saved Messages...`);

      const uploadStart = Date.now();
      const sentMsg = await client.sendMedia("me", {
        type: "document",
        file: TMP_ARCHIVE,
        fileName: `worlds_plugins_${ts.replace(/[:.]/g, "-").replace("T", "_").slice(0, 19)}.tar.gz`,
        caption: `🗄 *Pterodactyl Backup*\n📅 ${ts}\n💾 ${sizeMB} MB\n📦 worlds + plugins`,
      });
      log("telegram", `Upload done in ${((Date.now() - uploadStart) / 1000).toFixed(1)}s — msg ID ${sentMsg.id}`);

      // 4. Delete previous Telegram backup message (keep Saved Messages clean)
      if (state.previousTelegramMsgId) {
        try {
          await client.deleteMessagesById("me", [state.previousTelegramMsgId]);
          log("telegram", `Deleted previous backup message ${state.previousTelegramMsgId}`);
        } catch (err) {
          log("telegram", `Could not delete old message: ${String(err)}`);
        }
      }

      // 5. Delete the archive from the panel server
      await deleteArchiveFromServer(archiveName);

      // 6. Clean up local temp file
      await fsp.rm(TMP_ARCHIVE, { force: true });

      // 7. Save state for next cycle
      saveState({ previousTelegramMsgId: sentMsg.id });

      const elapsed = Date.now() - cycleStart;
      const waitMs = Math.max(0, INTERVAL_MS - elapsed);
      log("bot", `✓ Cycle done in ${(elapsed / 1000).toFixed(1)}s — next backup in ${Math.ceil(waitMs / 1000)}s`);
      await sleep(waitMs);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("bot", `✗ Cycle error: ${msg}`);
      // Short retry wait on error
      await sleep(30_000);
    }
  }
}

main().catch((err: unknown) => {
  console.error("[bot] Fatal:", err);
  process.exit(1);
});
