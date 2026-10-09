// Claude Code session transcripts: one JSON record per line. Unreadable lines are skipped.
// The format is internal to Claude Code and may change between releases. These scripts read
// `type`, `uuid`, `timestamp`, `isMeta`, `isCompactSummary`, `message.content` (text and tool_use
// blocks) and the `<command-name>` tag of slash commands, as written by Claude Code 2.1.x. If a field
// goes missing, evidence ids come out empty and the nudge stays quiet; nothing breaks.
import { existsSync, readFileSync } from "node:fs";

export const parseRecords = (raw) =>
  raw.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });

export const readTranscript = (path) => (path && existsSync(path) ? parseRecords(readFileSync(path, "utf8")) : []);

export const contentBlocks = (record) => (Array.isArray(record?.message?.content) ? record.message.content : []);
