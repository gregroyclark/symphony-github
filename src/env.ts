import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export function loadEnvFilesForWorkflow(workflowPath: string): void {
  const workflowDir = path.dirname(path.resolve(workflowPath));
  const cwdEnv = path.resolve(".env");
  const workflowEnv = path.join(workflowDir, ".env");

  loadEnvFile(cwdEnv);
  if (workflowEnv !== cwdEnv) {
    loadEnvFile(workflowEnv);
  }
}

function loadEnvFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  const text = readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals === -1) continue;

    const key = line.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;

    const rawValue = line.slice(equals + 1).trim();
    process.env[key] = unquoteEnvValue(rawValue);
  }
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).replace(/\\n/g, "\n");
  }
  return value;
}
