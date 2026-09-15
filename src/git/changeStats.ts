import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type FileChangeStats = {
  /** Raw git numstat additions (for display). */
  additions: number;
  /** Raw git numstat deletions (for display). */
  deletions: number;
  binary: boolean;
  /**
   * Line-multiset additions used for Sort by Changes.
   * Ignores identical lines that only moved; falls back to `additions` when unset.
   */
  contentAdditions?: number;
  /**
   * Line-multiset deletions used for Sort by Changes.
   * Ignores identical lines that only moved; falls back to `deletions` when unset.
   */
  contentDeletions?: number;
};

/**
 * Line change counts between two commits (git diff --numstat).
 * Keys are POSIX paths relative to the repository root (new path for renames).
 */
export async function loadChangeStats(
  repoRootFsPath: string,
  mergeBase: string,
  headRef: string
): Promise<Map<string, FileChangeStats>> {
  const { stdout } = await execFileAsync(
    'git',
    ['diff', '--numstat', '--find-renames', mergeBase, headRef],
    {
      cwd: repoRootFsPath,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true
    }
  );

  const stats = new Map<string, FileChangeStats>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) {
      continue;
    }
    const firstTab = line.indexOf('\t');
    const secondTab = firstTab >= 0 ? line.indexOf('\t', firstTab + 1) : -1;
    if (firstTab < 0 || secondTab < 0) {
      continue;
    }

    const addedField = line.slice(0, firstTab);
    const deletedField = line.slice(firstTab + 1, secondTab);
    const pathField = line.slice(secondTab + 1);
    const relativePath = parseNumstatPath(pathField);
    if (!relativePath) {
      continue;
    }

    if (addedField === '-' || deletedField === '-') {
      stats.set(relativePath, { additions: 0, deletions: 0, binary: true });
      continue;
    }

    const additions = Number.parseInt(addedField, 10);
    const deletions = Number.parseInt(deletedField, 10);
    if (!Number.isFinite(additions) || !Number.isFinite(deletions)) {
      continue;
    }
    stats.set(relativePath, { additions, deletions, binary: false });
  }

  return stats;
}

export function changeQuantity(stats: FileChangeStats | undefined): number {
  if (!stats || stats.binary) {
    // Push binary / unknown files after numeric counts when sorting ascending.
    return Number.MAX_SAFE_INTEGER;
  }
  const additions = stats.contentAdditions ?? stats.additions;
  const deletions = stats.contentDeletions ?? stats.deletions;
  return additions + deletions;
}

/**
 * Counts shown in the tree badge / tooltip.
 * When `includeMovedLineChanges` is false, identical moved lines are excluded.
 */
export function displayChangeCounts(
  stats: FileChangeStats,
  includeMovedLineChanges: boolean
): { additions: number; deletions: number } {
  if (!includeMovedLineChanges) {
    return {
      additions: stats.contentAdditions ?? stats.additions,
      deletions: stats.contentDeletions ?? stats.deletions
    };
  }
  return { additions: stats.additions, deletions: stats.deletions };
}

export function formatChangeStatsDescription(
  statusLetter: string,
  stats: FileChangeStats | undefined,
  includeMovedLineChanges = true
): string {
  if (!stats) {
    return statusLetter;
  }
  if (stats.binary) {
    return `${statusLetter}  —`;
  }
  const { additions, deletions } = displayChangeCounts(
    stats,
    includeMovedLineChanges
  );
  const total = additions + deletions;
  return `${statusLetter}  ${total} (+${additions} −${deletions})`;
}

/** Resolve the destination path from a numstat path field (handles renames). */
export function parseNumstatPath(pathField: string): string {
  const trimmed = pathField.trim();
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(trimmed);
  if (brace) {
    return `${brace[1]}${brace[3]}${brace[4]}`.replace(/\\/g, '/');
  }
  const arrow = /^(.*) => (.*)$/.exec(trimmed);
  if (arrow) {
    return arrow[2].replace(/\\/g, '/');
  }
  return trimmed.replace(/\\/g, '/');
}
