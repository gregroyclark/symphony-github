import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { ConfigError } from "../errors.js";
import type { WorkflowDefinition } from "../domain.js";
import { asRecord } from "../utils.js";

export async function loadWorkflow(workflowPath = "WORKFLOW.md"): Promise<WorkflowDefinition> {
  const resolvedPath = path.resolve(workflowPath);
  let text: string;
  let stats;

  try {
    [text, stats] = await Promise.all([readFile(resolvedPath, "utf8"), stat(resolvedPath)]);
  } catch (error) {
    throw new ConfigError(`Unable to read workflow file at ${resolvedPath}: ${String(error)}`);
  }

  const { config, body } = parseWorkflowDocument(text);
  return {
    path: resolvedPath,
    baseDir: path.dirname(resolvedPath),
    config,
    promptTemplate: body.trim(),
    mtimeMs: stats.mtimeMs
  };
}

export function parseWorkflowDocument(text: string): {
  config: Record<string, unknown>;
  body: string;
} {
  if (!text.startsWith("---")) {
    return { config: {}, body: text };
  }

  const lines = text.split(/\r?\n/);
  let closingIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === "---") {
      closingIndex = index;
      break;
    }
  }

  if (closingIndex === -1) {
    throw new ConfigError("Workflow front matter starts with --- but has no closing ---");
  }

  const yamlText = lines.slice(1, closingIndex).join("\n");
  const body = lines.slice(closingIndex + 1).join("\n");
  const parsed = yamlText.trim() ? YAML.parse(yamlText) : {};
  const config = asRecord(parsed);

  if (parsed && (typeof parsed !== "object" || Array.isArray(parsed))) {
    throw new ConfigError("Workflow front matter must parse to a YAML object");
  }

  return { config, body };
}
