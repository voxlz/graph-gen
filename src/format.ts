import fs from "node:fs";
import { parseGraphText } from "./parse";

export interface FormatResult {
  formatted: string;
  errors: string[];
}

function countBraces(line: string): number {
  let delta = 0;
  let inString = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    const next = line[index + 1];
    if (inString) {
      if (character === '"' && line[index - 1] !== "\\") inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "/" && next === "/") break;
    if (character === "{") delta++;
    if (character === "}") delta--;
  }
  return delta;
}

function leadingClosingBraces(line: string): number {
  let count = 0;
  for (const character of line) {
    if (character !== "}") break;
    count++;
  }
  return count;
}

export function formatGraphText(text: string): FormatResult {
  const parsed = parseGraphText(text);
  if (parsed.errors.length > 0) {
    return { formatted: text, errors: parsed.errors };
  }

  let depth = 0;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const formatted: string[] = [];
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (!line) {
      const next = lines
        .slice(index + 1)
        .find((candidate) => candidate.trim())
        ?.trim();
      if ((depth === 0 || next?.startsWith("//")) && formatted.at(-1) !== "") {
        formatted.push("");
      }
      continue;
    }

    const indentation = Math.max(0, depth - leadingClosingBraces(line));
    formatted.push(`${" ".repeat(indentation * 4)}${line}`);
    depth = Math.max(0, depth + countBraces(line));
  }

  while (formatted[0] === "") formatted.shift();
  while (formatted.at(-1) === "") formatted.pop();
  return { formatted: `${formatted.join("\n")}\n`, errors: [] };
}

export function formatGraphFile(file: string): FormatResult {
  const text = fs.readFileSync(file, "utf8");
  const result = formatGraphText(text);
  if (result.errors.length === 0 && result.formatted !== text) {
    fs.writeFileSync(file, result.formatted);
  }
  return result;
}
