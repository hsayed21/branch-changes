import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type GitDiffAlgorithm = 'myers' | 'histogram' | 'patience' | 'minimal';

export const GIT_DIFF_ALGORITHMS: readonly GitDiffAlgorithm[] = [
  'myers',
  'histogram',
  'patience',
  'minimal'
] as const;

export type NumstatEntry = {
  additions: number;
  deletions: number;
  binary: boolean;
};

export type FileChangeStats = {
  /** Raw git numstat additions. */
  additions: number;
  /** Raw git numstat deletions. */
  deletions: number;
  binary: boolean;
  /**
   * Per-line additions from `git diff --numstat --ignore-all-space`.
   * Falls back to `additions` when unset.
   */
  contentAdditions?: number;
  /**
   * Per-line deletions from `git diff --numstat --ignore-all-space`.
   * Falls back to `deletions` when unset.
   */
  contentDeletions?: number;
};

export function normalizeGitDiffAlgorithm(
  value: string | undefined
): GitDiffAlgorithm {
  if (
    value === 'myers' ||
    value === 'histogram' ||
    value === 'patience' ||
    value === 'minimal'
  ) {
    return value;
  }
  return 'histogram';
}

/**
 * Line change counts between two commits.
 * Loads raw numstat and ignore-all-space numstat with the given diff algorithm.
 */
export async function loadChangeStats(
  repoRootFsPath: string,
  mergeBase: string,
  headRef: string,
  algorithm: GitDiffAlgorithm = 'histogram'
): Promise<Map<string, FileChangeStats>> {
  const [raw, ignoreSpace] = await Promise.all([
    runNumstat(repoRootFsPath, mergeBase, headRef, algorithm, false),
    runNumstat(repoRootFsPath, mergeBase, headRef, algorithm, true)
  ]);
  return mergeChangeStats(raw, ignoreSpace);
}

async function runNumstat(
  repoRootFsPath: string,
  mergeBase: string,
  headRef: string,
  algorithm: GitDiffAlgorithm,
  ignoreAllSpace: boolean
): Promise<Map<string, NumstatEntry>> {
  const args = [
    'diff',
    '--numstat',
    '--find-renames',
    `--diff-algorithm=${algorithm}`
  ];
  if (ignoreAllSpace) {
    args.push('--ignore-all-space');
  }
  args.push(mergeBase, headRef);

  const { stdout } = await execFileAsync('git', args, {
    cwd: repoRootFsPath,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true
  });
  return parseNumstatOutput(stdout);
}

/** Parse `git diff --numstat` stdout into a path → counts map. */
export function parseNumstatOutput(stdout: string): Map<string, NumstatEntry> {
  const stats = new Map<string, NumstatEntry>();
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

/** Combine raw and ignore-all-space numstat maps. */
export function mergeChangeStats(
  raw: Map<string, NumstatEntry>,
  ignoreSpace: Map<string, NumstatEntry>
): Map<string, FileChangeStats> {
  const stats = new Map<string, FileChangeStats>();
  for (const [relativePath, entry] of raw) {
    const spaced = ignoreSpace.get(relativePath);
    stats.set(relativePath, {
      additions: entry.additions,
      deletions: entry.deletions,
      binary: entry.binary,
      contentAdditions: spaced?.additions ?? entry.additions,
      contentDeletions: spaced?.deletions ?? entry.deletions
    });
  }
  return stats;
}

export function changeQuantity(stats: FileChangeStats | undefined): number {
  if (!stats || stats.binary) {
    return Number.MAX_SAFE_INTEGER;
  }
  const additions = stats.contentAdditions ?? stats.additions;
  const deletions = stats.contentDeletions ?? stats.deletions;
  return additions + deletions;
}

/**
 * Counts shown in the tree badge / tooltip.
 * When `includeMovedLineChanges` is false, use ignore-all-space line counts.
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
  includeMovedLineChanges = false
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
