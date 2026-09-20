import * as vscode from 'vscode';

let gitApiPromise: Promise<GitApi> | undefined;

export async function getGitApi(): Promise<GitApi> {
  gitApiPromise ??= activateGitApi();
  return gitApiPromise;
}

/** Wait until the Git extension finished its initial repository scan. */
export async function waitForGitInitialized(git: GitApi): Promise<void> {
  // Older Git builds may omit state; treat that as already ready.
  if (!git.onDidChangeState || git.state === 'initialized' || git.state == null) {
    return;
  }

  await new Promise<void>(resolve => {
    const subscription = git.onDidChangeState(state => {
      if (state === 'initialized') {
        subscription.dispose();
        resolve();
      }
    });
    // State may flip between subscribe and check.
    if (git.state === 'initialized') {
      subscription.dispose();
      resolve();
    }
  });
}

async function activateGitApi(): Promise<GitApi> {
  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!extension) {
    throw new Error('VS Code\'s built-in Git extension is not available.');
  }

  const gitExtension = extension.isActive ? extension.exports : await extension.activate();
  if (!gitExtension.enabled) {
    throw new Error('VS Code\'s built-in Git extension is disabled.');
  }

  return gitExtension.getAPI(1);
}

export function repositoryDisplayName(repository: GitRepository): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(repository.rootUri);
  return workspaceFolder?.name ?? repository.rootUri.fsPath;
}

export function branchRef(branch: GitRef): string | undefined {
  if (!branch.name) {
    return undefined;
  }
  if (branch.type !== GitRefType.RemoteHead || !branch.remote) {
    return branch.name;
  }
  return branch.name.startsWith(`${branch.remote}/`)
    ? branch.name
    : `${branch.remote}/${branch.name}`;
}

export function isCurrentTrackingBranch(ref: string, head: GitBranch): boolean {
  return Boolean(
    head.upstream && ref === `${head.upstream.remote}/${head.upstream.name}`
  );
}

export interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitApi;
}

export interface GitApi {
  readonly state: 'uninitialized' | 'initialized';
  readonly onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>;
  readonly repositories: readonly GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
  getRepository(uri: vscode.Uri): GitRepository | null;
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}

export interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly HEAD: GitBranch | undefined;
    readonly remotes: readonly { readonly name: string }[];
  };
  readonly ui: {
    readonly selected: boolean;
    readonly onDidChange: vscode.Event<void>;
  };
  getBranchBase?(name: string): Promise<GitBranch | undefined>;
  getCommit(ref: string): Promise<unknown>;
  getMergeBase(ref1: string, ref2: string): Promise<string | undefined>;
  getRefs(query: Record<string, never>): Promise<GitRef[]>;
  diffBetween(ref1: string, ref2: string): Promise<GitChange[]>;
}

export interface GitRef {
  readonly type: GitRefType;
  readonly name?: string;
  readonly remote?: string;
}

export interface GitBranch extends GitRef {
  readonly commit?: string;
  readonly upstream?: {
    readonly remote: string;
    readonly name: string;
  };
}

export interface GitChange {
  readonly uri: vscode.Uri;
  readonly originalUri: vscode.Uri;
  readonly status: GitStatus;
}

export const enum GitRefType {
  Head = 0,
  RemoteHead = 1
}

export const enum GitStatus {
  IndexAdded = 1,
  IndexDeleted = 2,
  IndexRenamed = 3,
  IndexCopied = 4,
  Deleted = 6
}
