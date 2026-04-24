import fs from "fs";
import path from "path";
import dotenv from "dotenv";

let loaded = false;

function loadIfExists(filePath: string, override = false) {
  if (!fs.existsSync(filePath)) return;
  dotenv.config({ path: filePath, override });
}

export function loadEnvironment() {
  if (loaded) return;
  loaded = true;

  const cwd = process.cwd();
  loadIfExists(path.join(cwd, ".env"));
  loadIfExists(path.join(cwd, ".env.local"), true);
}
