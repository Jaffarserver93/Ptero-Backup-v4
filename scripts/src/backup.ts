import { setTimeout as sleep } from "timers/promises";

const PANEL_URL = process.env["PTERODACTYL_URL"]?.replace(/\/$/, "");
const API_KEY = process.env["PTERODACTYL_API_KEY"];
const SERVER_ID = process.env["PTERODACTYL_SERVER_ID"];

const FOLDERS_TO_BACKUP = ["worlds", "plugins"];
const BACKUP_DIR = "backups";

if (!PANEL_URL || !API_KEY || !SERVER_ID) {
  console.error(
    "Missing required environment variables: PTERODACTYL_URL, PTERODACTYL_API_KEY, PTERODACTYL_SERVER_ID"
  );
  process.exit(1);
}

function headers() {
  return {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function apiGet(path: string) {
  const res = await fetch(`${PANEL_URL}/api/client${path}`, {
    headers: headers(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function apiPost(path: string, body: unknown) {
  const res = await fetch(`${PANEL_URL}/api/client${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST ${path} failed (${res.status}): ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

async function apiPut(path: string, body: unknown) {
  const res = await fetch(`${PANEL_URL}/api/client${path}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PUT ${path} failed (${res.status}): ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

async function apiDelete(path: string) {
  const res = await fetch(`${PANEL_URL}/api/client${path}`, {
    method: "DELETE",
    headers: headers(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DELETE ${path} failed (${res.status}): ${text}`);
  }
}

async function ensureBackupDir() {
  const base = `/servers/${SERVER_ID}/files`;
  try {
    await apiGet(`${base}/list?directory=/${BACKUP_DIR}`);
    console.log(`[backup] /${BACKUP_DIR} directory already exists`);
  } catch {
    console.log(`[backup] Creating /${BACKUP_DIR} directory...`);
    await apiPost(`${base}/create-folder`, {
      root: "/",
      name: BACKUP_DIR,
    });
    console.log(`[backup] /${BACKUP_DIR} created`);
  }
}

async function compressFolder(folder: string, destName: string) {
  console.log(`[backup] Compressing /${folder} → /${BACKUP_DIR}/${destName}`);
  await apiPost(`/servers/${SERVER_ID}/files/compress`, {
    root: "/",
    files: [folder],
  });

  const zipName = `${folder}.tar.gz`;
  console.log(`[backup] Moving ${zipName} → /${BACKUP_DIR}/${destName}`);
  await apiPut(`/servers/${SERVER_ID}/files/rename`, {
    root: "/",
    files: [
      {
        from: zipName,
        to: `${BACKUP_DIR}/${destName}`,
      },
    ],
  });

  console.log(`[backup] ✓ ${destName} saved to /${BACKUP_DIR}/`);
}

interface PteroFile {
  attributes: {
    is_file: boolean;
    name: string;
    created_at: string;
  };
}

interface PteroListResponse {
  data: PteroFile[];
}

async function listBackupFiles(): Promise<{ name: string; created_at: string }[]> {
  try {
    const data = (await apiGet(
      `/servers/${SERVER_ID}/files/list?directory=/${BACKUP_DIR}`
    )) as PteroListResponse;
    return (data?.data ?? [])
      .filter((f) => f.attributes.is_file)
      .map((f) => ({
        name: f.attributes.name,
        created_at: f.attributes.created_at,
      }));
  } catch {
    return [];
  }
}

async function pruneOldBackups(prefix: string, keepCount = 5) {
  const files = await listBackupFiles();
  const matching = files
    .filter((f) => f.name.startsWith(prefix))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  const toDelete = matching.slice(0, Math.max(0, matching.length - keepCount));
  for (const file of toDelete) {
    console.log(`[backup] Pruning old backup: ${file.name}`);
    await apiPost(`/servers/${SERVER_ID}/files/delete`, {
      root: `/${BACKUP_DIR}`,
      files: [file.name],
    });
  }
}

async function run() {
  const now = new Date();
  const timestamp = now
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);

  console.log(`\n=== Pterodactyl Backup — ${now.toISOString()} ===`);

  await ensureBackupDir();

  for (const folder of FOLDERS_TO_BACKUP) {
    const destName = `${folder}_${timestamp}.tar.gz`;
    try {
      await compressFolder(folder, destName);
      await sleep(2000);
      await pruneOldBackups(`${folder}_`, 5);
    } catch (err) {
      console.error(`[backup] ✗ Failed to back up ${folder}:`, err);
    }
  }

  console.log(`=== Backup complete ===\n`);
}

run().catch((err) => {
  console.error("[backup] Fatal error:", err);
  process.exit(1);
});
