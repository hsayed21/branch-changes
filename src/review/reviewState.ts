export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export function reviewStorageKey(repoUri: string, branchName: string): string {
  return `branchChanges.reviewed:${repoUri}:${branchName}`;
}

type Listener = () => void;

/** path → content hash at the time the file was marked reviewed */
type ReviewedMap = Record<string, string>;

export class ReviewState {
  private readonly key: string;
  private reviewed: Map<string, string>;
  private readonly listeners = new Set<Listener>();
  readonly onDidChange = (listener: Listener): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  constructor(
    private readonly memento: MementoLike,
    repoUri: string,
    branchName: string
  ) {
    this.key = reviewStorageKey(repoUri, branchName);
    this.reviewed = loadReviewedMap(this.memento.get(this.key));
  }

  getReviewedPaths(): ReadonlySet<string> {
    return new Set(this.reviewed.keys());
  }

  isReviewed(path: string): boolean {
    return this.reviewed.has(path);
  }

  /**
   * Toggle reviewed. When marking reviewed, `contentHash` is required and stored.
   * When marking unreviewed, hash is ignored.
   */
  async toggle(path: string, contentHash?: string): Promise<boolean> {
    if (this.reviewed.has(path)) {
      this.reviewed.delete(path);
    } else {
      if (!contentHash) {
        throw new Error('contentHash is required when marking a file as reviewed.');
      }
      this.reviewed.set(path, contentHash);
    }
    await this.persist();
    this.fire();
    return this.reviewed.has(path);
  }

  /** Clear every reviewed mark for this repo+branch. Returns how many were cleared. */
  async clearAll(): Promise<number> {
    const count = this.reviewed.size;
    if (count === 0) {
      return 0;
    }
    this.reviewed.clear();
    await this.persist();
    this.fire();
    return count;
  }

  /**
   * Drop paths that left the change set, and clear review when the stored
   * content hash no longer matches the current HEAD hash (file changed).
   */
  async reconcile(activeHashes: ReadonlyMap<string, string>): Promise<boolean> {
    let changed = false;
    for (const [path, storedHash] of [...this.reviewed]) {
      const currentHash = activeHashes.get(path);
      if (currentHash === undefined || currentHash !== storedHash) {
        this.reviewed.delete(path);
        changed = true;
      }
    }
    if (changed) {
      await this.persist();
      this.fire();
    }
    return changed;
  }

  private fire(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private async persist(): Promise<void> {
    const record: ReviewedMap = {};
    for (const path of [...this.reviewed.keys()].sort()) {
      record[path] = this.reviewed.get(path)!;
    }
    await this.memento.update(this.key, record);
  }
}

function loadReviewedMap(stored: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!stored) {
    return map;
  }

  // Legacy format: string[] of paths (no hashes) — treat as unreviewed so
  // the next mark stores a proper hash. Avoids keeping stale reviews forever.
  if (Array.isArray(stored)) {
    return map;
  }

  if (typeof stored === 'object') {
    for (const [path, hash] of Object.entries(stored as ReviewedMap)) {
      if (typeof path === 'string' && typeof hash === 'string' && hash.length > 0) {
        map.set(path, hash);
      }
    }
  }

  return map;
}
