import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SETUP_STATE_DIR = path.resolve(MODULE_DIR, "..", "..", ".data");
const SETUP_STATE_FILE = path.join(SETUP_STATE_DIR, "setup-state.json");

export function readPersistedSetupState() {
  try {
    const raw = fs.readFileSync(SETUP_STATE_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function writePersistedSetupState(payload) {
  fs.mkdirSync(SETUP_STATE_DIR, { recursive: true });
  fs.writeFileSync(SETUP_STATE_FILE, JSON.stringify(payload, null, 2));
}
