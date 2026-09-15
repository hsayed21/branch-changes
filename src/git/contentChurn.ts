/**
 * Count how many lines were truly added/removed by comparing line multisets.
 * Lines that only move (same text, different order) do not count.
 */
export function lineContentChurn(
  before: string,
  after: string
): { additions: number; deletions: number } {
  const beforeCounts = countLines(before);
  const afterCounts = countLines(after);
  let additions = 0;
  let deletions = 0;

  for (const [line, afterCount] of afterCounts) {
    const beforeCount = beforeCounts.get(line) ?? 0;
    if (afterCount > beforeCount) {
      additions += afterCount - beforeCount;
    }
  }

  for (const [line, beforeCount] of beforeCounts) {
    const afterCount = afterCounts.get(line) ?? 0;
    if (beforeCount > afterCount) {
      deletions += beforeCount - afterCount;
    }
  }

  return { additions, deletions };
}

function countLines(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of splitLines(text)) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

/** Split on newlines; keep a trailing empty line only when the text ends with one. */
export function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return normalized.split('\n');
}
