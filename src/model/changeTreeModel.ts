import path from 'node:path';

export type ChangeFileNode = {
  kind: 'file';
  relativePath: string;
  status: number;
  reviewed: boolean;
  additions: number;
  deletions: number;
  /** Multiset additions for Sort by Changes (moved-identical lines ignored). */
  contentAdditions: number;
  /** Multiset deletions for Sort by Changes (moved-identical lines ignored). */
  contentDeletions: number;
  binary: boolean;
};

export type ChangeFolderNode = {
  kind: 'folder';
  relativePath: string;
  name: string;
  children: ChangeNode[];
  reviewedCount: number;
  totalFiles: number;
  additions: number;
  deletions: number;
  contentAdditions: number;
  contentDeletions: number;
};

export type ChangeNode = ChangeFileNode | ChangeFolderNode;

/** Which files to show in the Branch Changes view. */
export type ReviewFilter = 'all' | 'unreviewed' | 'reviewed';

export type ViewMode = 'tree' | 'list';

export type BuildTreeOptions = {
  /** When true, unreviewed items stay on top; fully reviewed items sink to the bottom. */
  sortReviewedToBottom?: boolean;
  /** When true, group files by change status (A, M, D, …) before sorting by name. */
  sortByStatus?: boolean;
  /**
   * When true, sort by effective content churn (fewest first), ignoring identical
   * lines that only moved. Takes precedence over sortByStatus.
   */
  sortByChanges?: boolean;
};

export type FileChangeInput = {
  relativePath: string;
  status: number;
  additions?: number;
  deletions?: number;
  contentAdditions?: number;
  contentDeletions?: number;
  binary?: boolean;
};

/** Sort rank for status grouping: A → M → D → R → C (matches status letters in the view). */
export function statusSortRank(status: number): number {
  switch (status) {
    case 1: // IndexAdded → A
      return 0;
    case 2: // IndexDeleted → D
    case 6: // Deleted → D
      return 2;
    case 3: // IndexRenamed → R
      return 3;
    case 4: // IndexCopied → C
      return 4;
    default: // Modified and other → M
      return 1;
  }
}

export function toPosixRelativePath(
  repoRootFsPath: string,
  fileFsPath: string
): string {
  const rel = path.relative(repoRootFsPath, fileFsPath);
  return rel.split(path.sep).join('/');
}

/**
 * Format a relative path for list-view labels.
 * When maxParts > 0 and the path has more segments, keep the last N and prefix with '../'.
 * maxParts <= 0 means show the full path.
 */
export function formatListPathLabel(
  relativePath: string,
  maxParts: number
): string {
  if (maxParts <= 0) {
    return relativePath;
  }
  const segments = relativePath.split('/').filter(segment => segment.length > 0);
  if (segments.length <= maxParts) {
    return segments.join('/');
  }
  return `../${segments.slice(-maxParts).join('/')}`;
}

interface FolderBuilder {
  name: string;
  relativePath: string;
  subfolders: Map<string, FolderBuilder>;
  files: ChangeFileNode[];
}

function createRootBuilder(): FolderBuilder {
  return { name: '', relativePath: '', subfolders: new Map(), files: [] };
}

function addFileToBuilder(
  root: FolderBuilder,
  file: FileChangeInput,
  reviewed: boolean
): void {
  const segments = file.relativePath.split('/');
  segments.pop(); // file name
  let current = root;
  let pathSoFar = '';

  for (const segment of segments) {
    pathSoFar = pathSoFar ? `${pathSoFar}/${segment}` : segment;
    let subfolder = current.subfolders.get(segment);
    if (!subfolder) {
      subfolder = {
        name: segment,
        relativePath: pathSoFar,
        subfolders: new Map(),
        files: []
      };
      current.subfolders.set(segment, subfolder);
    }
    current = subfolder;
  }

  const additions = file.additions ?? 0;
  const deletions = file.deletions ?? 0;
  current.files.push({
    kind: 'file',
    relativePath: file.relativePath,
    status: file.status,
    reviewed,
    additions,
    deletions,
    contentAdditions: file.contentAdditions ?? additions,
    contentDeletions: file.contentDeletions ?? deletions,
    binary: file.binary ?? false
  });
}

function nodeSortName(node: ChangeNode): string {
  return node.kind === 'folder'
    ? node.name
    : node.relativePath.split('/').pop()!;
}

/** True when a file is reviewed, or a folder has only reviewed files. */
export function nodeIsFullyReviewed(node: ChangeNode): boolean {
  if (node.kind === 'file') {
    return node.reviewed;
  }
  return node.totalFiles > 0 && node.reviewedCount === node.totalFiles;
}

/**
 * Sort key for Sort by Changes: effective content churn (moved-identical lines
 * ignored). Binary files sort last.
 */
export function nodeChangeQuantity(node: ChangeNode): number {
  if (node.kind === 'file') {
    return node.binary
      ? Number.MAX_SAFE_INTEGER
      : node.contentAdditions + node.contentDeletions;
  }
  return node.contentAdditions + node.contentDeletions;
}

function compareNodes(
  a: ChangeNode,
  b: ChangeNode,
  sortReviewedToBottom: boolean,
  sortByStatus: boolean,
  sortByChanges: boolean
): number {
  if (sortReviewedToBottom) {
    const aDone = nodeIsFullyReviewed(a);
    const bDone = nodeIsFullyReviewed(b);
    if (aDone !== bDone) {
      return aDone ? 1 : -1;
    }
  }
  if (a.kind !== b.kind) {
    return a.kind === 'folder' ? -1 : 1;
  }
  if (sortByChanges) {
    const byChanges = nodeChangeQuantity(a) - nodeChangeQuantity(b);
    if (byChanges !== 0) {
      return byChanges;
    }
  } else if (sortByStatus && a.kind === 'file' && b.kind === 'file') {
    const byStatus = statusSortRank(a.status) - statusSortRank(b.status);
    if (byStatus !== 0) {
      return byStatus;
    }
  }
  return nodeSortName(a).localeCompare(nodeSortName(b));
}

function aggregateCounts(children: ChangeNode[]): {
  reviewedCount: number;
  totalFiles: number;
  additions: number;
  deletions: number;
  contentAdditions: number;
  contentDeletions: number;
} {
  let reviewedCount = 0;
  let totalFiles = 0;
  let additions = 0;
  let deletions = 0;
  let contentAdditions = 0;
  let contentDeletions = 0;
  for (const child of children) {
    if (child.kind === 'file') {
      totalFiles += 1;
      if (child.reviewed) {
        reviewedCount += 1;
      }
      if (!child.binary) {
        additions += child.additions;
        deletions += child.deletions;
        contentAdditions += child.contentAdditions;
        contentDeletions += child.contentDeletions;
      }
    } else {
      totalFiles += child.totalFiles;
      reviewedCount += child.reviewedCount;
      additions += child.additions;
      deletions += child.deletions;
      contentAdditions += child.contentAdditions;
      contentDeletions += child.contentDeletions;
    }
  }
  return {
    reviewedCount,
    totalFiles,
    additions,
    deletions,
    contentAdditions,
    contentDeletions
  };
}

function finalizeFolder(
  folder: FolderBuilder,
  sortReviewedToBottom: boolean,
  sortByStatus: boolean,
  sortByChanges: boolean
): ChangeFolderNode {
  const childFolders = [...folder.subfolders.values()].map(sub =>
    finalizeFolder(sub, sortReviewedToBottom, sortByStatus, sortByChanges)
  );
  const children: ChangeNode[] = [...childFolders, ...folder.files];
  const {
    reviewedCount,
    totalFiles,
    additions,
    deletions,
    contentAdditions,
    contentDeletions
  } = aggregateCounts(children);

  children.sort((a, b) =>
    compareNodes(a, b, sortReviewedToBottom, sortByStatus, sortByChanges)
  );

  return {
    kind: 'folder',
    relativePath: folder.relativePath,
    name: folder.name,
    children,
    reviewedCount,
    totalFiles,
    additions,
    deletions,
    contentAdditions,
    contentDeletions
  };
}

export function buildChangeTree(
  files: ReadonlyArray<FileChangeInput>,
  reviewed: ReadonlySet<string>,
  options?: BuildTreeOptions
): ChangeFolderNode {
  const sortReviewedToBottom = options?.sortReviewedToBottom ?? true;
  const sortByStatus = options?.sortByStatus ?? false;
  const sortByChanges = options?.sortByChanges ?? false;
  const root = createRootBuilder();

  for (const file of files) {
    addFileToBuilder(root, file, reviewed.has(file.relativePath));
  }

  return finalizeFolder(
    root,
    sortReviewedToBottom,
    sortByStatus,
    sortByChanges
  );
}

/**
 * Return a tree that only includes files matching the filter.
 * Empty folders are dropped. Counts reflect visible files only.
 */
export function filterChangeTree(
  root: ChangeFolderNode,
  filter: ReviewFilter,
  pathQuery?: string
): ChangeFolderNode {
  const trimmed = pathQuery?.trim() ?? '';
  if (filter === 'all' && !trimmed) {
    return root;
  }
  return filterFolder(root, filter, trimmed.toLowerCase());
}

function pathMatches(relativePath: string, pathQueryLower: string): boolean {
  return !pathQueryLower || relativePath.toLowerCase().includes(pathQueryLower);
}

function filterFolder(
  folder: ChangeFolderNode,
  filter: ReviewFilter,
  pathQueryLower: string
): ChangeFolderNode {
  const children: ChangeNode[] = [];

  for (const child of folder.children) {
    if (child.kind === 'file') {
      const reviewOk =
        filter === 'all' ||
        (filter === 'unreviewed' ? !child.reviewed : child.reviewed);
      if (reviewOk && pathMatches(child.relativePath, pathQueryLower)) {
        children.push(child);
      }
    } else {
      const filtered = filterFolder(child, filter, pathQueryLower);
      if (filtered.children.length > 0) {
        children.push(filtered);
      }
    }
  }

  const {
    reviewedCount,
    totalFiles,
    additions,
    deletions,
    contentAdditions,
    contentDeletions
  } = aggregateCounts(children);
  return {
    kind: 'folder',
    relativePath: folder.relativePath,
    name: folder.name,
    children,
    reviewedCount,
    totalFiles,
    additions,
    deletions,
    contentAdditions,
    contentDeletions
  };
}

export function shouldExpandFolder(
  folder: ChangeFolderNode,
  filter: ReviewFilter,
  pathQuery?: string
): boolean {
  if (folder.children.length === 0) {
    return false;
  }
  if (filter !== 'all' || (pathQuery?.trim() ?? '').length > 0) {
    return true;
  }
  return folder.reviewedCount < folder.totalFiles;
}

/** Flatten the change tree into a sorted list of files (for list view mode). */
export function flattenChangeFiles(
  root: ChangeFolderNode,
  options?: BuildTreeOptions & { filter?: ReviewFilter; pathQuery?: string }
): ChangeFileNode[] {
  const filter = options?.filter ?? 'all';
  const pathQueryLower = (options?.pathQuery?.trim() ?? '').toLowerCase();
  const sortReviewedToBottom = options?.sortReviewedToBottom ?? true;
  const sortByStatus = options?.sortByStatus ?? false;
  const files: ChangeFileNode[] = [];

  function walk(node: ChangeNode): void {
    if (node.kind === 'file') {
      const reviewOk =
        filter === 'all' ||
        (filter === 'unreviewed' ? !node.reviewed : node.reviewed);
      if (reviewOk && pathMatches(node.relativePath, pathQueryLower)) {
        files.push(node);
      }
      return;
    }
    for (const child of node.children) {
      walk(child);
    }
  }

  const sortByChanges = options?.sortByChanges ?? false;

  walk(root);
  files.sort((a, b) => {
    if (sortReviewedToBottom && a.reviewed !== b.reviewed) {
      return a.reviewed ? 1 : -1;
    }
    if (sortByChanges) {
      const byChanges = nodeChangeQuantity(a) - nodeChangeQuantity(b);
      if (byChanges !== 0) {
        return byChanges;
      }
    } else if (sortByStatus) {
      const byStatus = statusSortRank(a.status) - statusSortRank(b.status);
      if (byStatus !== 0) {
        return byStatus;
      }
    }
    return a.relativePath.localeCompare(b.relativePath);
  });
  return files;
}
