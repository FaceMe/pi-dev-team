/**
 * Small JSON file helpers shared by every extension in this package.
 *
 * Reads never throw and never write. Writes are atomic (temp file + rename) so a
 * crash or a concurrent reader never sees a half-written file.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export function readJsonFile<T = Record<string, any>>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as T) : null;
  } catch {
    return null;
  }
}

export function writeJsonFile(filePath: string, data: unknown): boolean {
  return writeTextFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

export function writeTextFile(filePath: string, text: string): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, filePath);
    return true;
  } catch (error) {
    console.error(`[pi-model-picker] failed to write ${filePath}:`, error);
    return false;
  }
}

export function appendJsonLine(filePath: string, data: unknown): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(data)}\n`, "utf8");
  } catch (error) {
    console.error(`[pi-model-picker] failed to append ${filePath}:`, error);
  }
}
