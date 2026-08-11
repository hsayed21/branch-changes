import * as vscode from 'vscode';

const SHOW_COMMAND = 'branchChanges.show';
const SET_BASE_COMMAND = 'branchChanges.setBase';
const STORAGE_PREFIX = 'branchChanges.base';

let extensionContext: vscode.ExtensionContext;
let gitApiPromise: Promise<GitApi> | undefined;

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;

  context.subscriptions.push(
    vscode.commands.registerCommand(SHOW_COMMAND, (sourceControl?: unknown) =>
      runCommand(() => showBranchChanges(sourceControl))),
    vscode.commands.registerCommand(SET_BASE_COMMAND, () =>
      runCommand(() => setBaseBranch()))
  );
}

export function deactivate(): void {
  // Nothing to dispose beyond the subscriptions owned by VS Code.
}

async function showBranchChanges(sourceControl?: unknown): Promise<void> {
  const git = await getGitApi();
  const repository = await selectRepository(git, sourceControl);
  if (!repository) {
    return;
  }

  const head = repository.state.HEAD;
  if (!head?.name) {
    throw new Error('Check out a branch before showing branch changes.');
  }

  let base = await findBaseBranch(repository, head);
  if (!base) {
    base = await pickAndSaveBaseBranch(repository, head);
  }
  if (!base) {
    return;
  }

  const headRef = head.commit ?? 'HEAD';
  const mergeBase = await repository.getMergeBase(base.ref, headRef);
  if (!mergeBase) {
    throw new Error(`No common ancestor was found between ${base.ref} and ${head.name}.`);
  }

  const changes = await repository.diffBetween(mergeBase, headRef);
  if (changes.length === 0) {
    void vscode.window.showInformationMessage(
      `Branch Changes: ${head.name} has no committed changes from ${base.ref}.`
    );
    return;
  }

  const resources = changes.map(change => createChangeResource(git, change, mergeBase, headRef));
  const title = `Changes in ${head.name} from ${base.ref}`;

  await vscode.commands.executeCommand('vscode.changes', title, resources);
}

async function setBaseBranch(): Promise<void> {
  const git = await getGitApi();
  const repository = await pickRepository(
    git.repositories,
    'Select the repository whose base branch you want to set'
  );
  if (!repository) {
    return;
  }

  const head = repository.state.HEAD;
  if (!head?.name) {
    throw new Error('Check out a branch before selecting its base branch.');
  }

  const base = await pickAndSaveBaseBranch(repository, head);
  if (base) {
    void vscode.window.showInformationMessage(
      `Branch Changes: ${base.ref} is now the base for ${repositoryDisplayName(repository)} / ${head.name}.`
    );
  }
}

async function findBaseBranch(repository: GitRepository, head: GitBranch): Promise<BaseBranch | undefined> {
  const savedBase = extensionContext.workspaceState.get<string>(baseStorageKey(repository, head.name!));
  const resolvedSavedBase = savedBase
    ? await resolveExistingRef(repository, savedBase)
    : undefined;
  if (resolvedSavedBase) {
    return { ref: resolvedSavedBase };
  }

  const configuration = vscode.workspace.getConfiguration('branchChanges', repository.rootUri);
  const configuredBase = configuration.get<string>('baseBranch', '').trim();
  const resolvedConfiguredBase = configuredBase
    ? await resolveExistingRef(repository, configuredBase)
    : undefined;
  if (resolvedConfiguredBase) {
    return { ref: resolvedConfiguredBase };
  }

  if (repository.getBranchBase) {
    const detectedBranch = await repository.getBranchBase(head.name!).catch(() => undefined);
    const detectedRef = detectedBranch ? branchRef(detectedBranch) : undefined;
    const resolvedDetectedRef = detectedRef
      ? await resolveExistingRef(repository, detectedRef)
      : undefined;
    if (resolvedDetectedRef && !isCurrentTrackingBranch(resolvedDetectedRef, head)) {
      return { ref: resolvedDetectedRef };
    }
  }

  const refs = await repository.getRefs({});
  const defaultRemoteRef = findDefaultRemoteRef(refs, head.upstream?.remote);
  if (defaultRemoteRef) {
    return { ref: defaultRemoteRef };
  }

  const fallbackNames = configuration.get<string[]>('fallbackBaseBranches', [
    'develop',
    'main',
    'master'
  ]);
  const fallbackRef = findFallbackRef(refs, fallbackNames, head.upstream?.remote);
  if (fallbackRef) {
    return { ref: fallbackRef };
  }

  return undefined;
}

async function pickAndSaveBaseBranch(
  repository: GitRepository,
  head: GitBranch
): Promise<BaseBranch | undefined> {
  const refs = await repository.getRefs({});
  const currentTrackingRef = head.upstream
    ? `${head.upstream.remote}/${head.upstream.name}`
    : undefined;
  const seen = new Set<string>();

  const items = refs
    .filter(ref => ref.type === GitRefType.Head || ref.type === GitRefType.RemoteHead)
    .map(ref => ({ ref: branchRef(ref), type: ref.type }))
    .filter((item): item is { ref: string; type: GitRefType } => Boolean(item.ref))
    .filter(item => item.ref !== head.name && item.ref !== currentTrackingRef)
    .filter(item => !item.ref.endsWith('/HEAD'))
    .filter(item => {
      if (seen.has(item.ref)) {
        return false;
      }
      seen.add(item.ref);
      return true;
    })
    .sort((left, right) => left.ref.localeCompare(right.ref))
    .map<BaseQuickPickItem>(item => ({
      label: item.ref,
      description: item.type === GitRefType.RemoteHead ? 'Remote branch' : 'Local branch',
      ref: item.ref
    }));

  if (items.length === 0) {
    throw new Error('No other local or remote branches are available as a base.');
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `Select the base branch for ${repositoryDisplayName(repository)} / ${head.name}`,
    matchOnDescription: true
  });
  if (!picked) {
    return undefined;
  }

  await extensionContext.workspaceState.update(baseStorageKey(repository, head.name!), picked.ref);
  return { ref: picked.ref };
}

function findDefaultRemoteRef(
  refs: readonly GitRef[],
  preferredRemote?: string
): string | undefined {
  const remoteHeadRefs = refs
    .filter(ref => ref.type === GitRefType.RemoteHead)
    .map(branchRef)
    .filter((ref): ref is string => Boolean(ref?.endsWith('/HEAD')));

  if (preferredRemote) {
    const preferredRemoteHead = remoteHeadRefs.find(ref => ref === `${preferredRemote}/HEAD`);
    if (preferredRemoteHead) {
      return preferredRemoteHead;
    }
  }

  return remoteHeadRefs.find(ref => ref === 'origin/HEAD') ?? remoteHeadRefs[0];
}

function findFallbackRef(
  refs: readonly GitRef[],
  fallbackNames: readonly string[],
  preferredRemote?: string
): string | undefined {
  const availableRefs = refs
    .map(ref => ({ ref: branchRef(ref), type: ref.type }))
    .filter((item): item is { ref: string; type: GitRefType } => Boolean(item.ref));

  for (const fallbackName of fallbackNames.map(name => name.trim()).filter(Boolean)) {
    const preferredRemoteRef = preferredRemote
      ? availableRefs.find(item => item.ref === `${preferredRemote}/${fallbackName}`)
      : undefined;
    if (preferredRemoteRef) {
      return preferredRemoteRef.ref;
    }

    const originRef = availableRefs.find(item => item.ref === `origin/${fallbackName}`);
    if (originRef) {
      return originRef.ref;
    }

    const anyRemoteRef = availableRefs.find(
      item => item.type === GitRefType.RemoteHead && item.ref.endsWith(`/${fallbackName}`)
    );
    if (anyRemoteRef) {
      return anyRemoteRef.ref;
    }

    const localRef = availableRefs.find(
      item => item.type === GitRefType.Head && item.ref === fallbackName
    );
    if (localRef) {
      return localRef.ref;
    }
  }

  return undefined;
}

async function resolveExistingRef(
  repository: GitRepository,
  requestedRef: string
): Promise<string | undefined> {
  const candidates = [requestedRef];
  if (!requestedRef.includes('/')) {
    const remoteNames = repository.state.remotes
      .map(remote => remote.name)
      .sort((left, right) => {
        if (left === 'origin') {
          return -1;
        }
        if (right === 'origin') {
          return 1;
        }
        return left.localeCompare(right);
      });
    candidates.push(...remoteNames.map(remote => `${remote}/${requestedRef}`));
  }

  for (const candidate of candidates) {
    try {
      await repository.getCommit(candidate);
      return candidate;
    } catch {
      // Try the next unambiguous local or remote form.
    }
  }

  return undefined;
}

function createChangeResource(
  git: GitApi,
  change: GitChange,
  mergeBase: string,
  headRef: string
): readonly [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined] {
  switch (change.status) {
    case GitStatus.IndexAdded:
      return [change.uri, undefined, git.toGitUri(change.uri, headRef)];
    case GitStatus.IndexDeleted:
    case GitStatus.Deleted:
      return [change.uri, git.toGitUri(change.uri, mergeBase), undefined];
    case GitStatus.IndexRenamed:
    case GitStatus.IndexCopied:
      return [
        change.uri,
        git.toGitUri(change.originalUri, mergeBase),
        git.toGitUri(change.uri, headRef)
      ];
    default:
      return [
        change.uri,
        git.toGitUri(change.uri, mergeBase),
        git.toGitUri(change.uri, headRef)
      ];
  }
}

async function selectRepository(
  git: GitApi,
  sourceControl?: unknown
): Promise<GitRepository | undefined> {
  const contextUri = sourceControlUri(sourceControl);
  const contextRepository = contextUri ? git.getRepository(contextUri) : null;
  if (contextRepository) {
    return contextRepository;
  }

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const activeRepository = activeUri ? git.getRepository(activeUri) : null;
  if (activeRepository) {
    return activeRepository;
  }

  const selectedRepository = git.repositories.find(repository => repository.ui.selected);
  if (selectedRepository) {
    return selectedRepository;
  }

  if (git.repositories.length === 0) {
    throw new Error('No Git repository is open.');
  }
  if (git.repositories.length === 1) {
    return git.repositories[0];
  }

  return pickRepository(git.repositories);
}

async function pickRepository(
  repositories: readonly GitRepository[],
  placeHolder = 'Select a Git repository'
): Promise<GitRepository | undefined> {
  if (repositories.length === 0) {
    throw new Error('No Git repository is open.');
  }

  const items = repositories.map<RepositoryQuickPickItem>(repository => ({
    label: repositoryDisplayName(repository),
    description: repository.state.HEAD?.name ?? 'No branch checked out',
    detail: repository.rootUri.fsPath,
    repository
  }));
  return (await vscode.window.showQuickPick(items, {
    placeHolder,
    matchOnDescription: true,
    matchOnDetail: true
  }))?.repository;
}

function repositoryDisplayName(repository: GitRepository): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(repository.rootUri);
  return workspaceFolder?.name ?? repository.rootUri.fsPath;
}

function sourceControlUri(value: unknown): vscode.Uri | undefined {
  if (value instanceof vscode.Uri) {
    return value;
  }
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const rootUri = (value as { rootUri?: unknown }).rootUri;
  return rootUri instanceof vscode.Uri ? rootUri : undefined;
}

function branchRef(branch: GitRef): string | undefined {
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

function isCurrentTrackingBranch(ref: string, head: GitBranch): boolean {
  return Boolean(
    head.upstream && ref === `${head.upstream.remote}/${head.upstream.name}`
  );
}

function baseStorageKey(repository: GitRepository, branchName: string): string {
  return `${STORAGE_PREFIX}:${repository.rootUri.toString()}:${branchName}`;
}

async function getGitApi(): Promise<GitApi> {
  gitApiPromise ??= activateGitApi();
  return gitApiPromise;
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

async function runCommand(command: () => Promise<void>): Promise<void> {
  try {
    await command();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Branch Changes: ${message}`);
  }
}

interface BaseBranch {
  readonly ref: string;
}

interface BaseQuickPickItem extends vscode.QuickPickItem {
  readonly ref: string;
}

interface RepositoryQuickPickItem extends vscode.QuickPickItem {
  readonly repository: GitRepository;
}

interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitApi;
}

interface GitApi {
  readonly repositories: readonly GitRepository[];
  getRepository(uri: vscode.Uri): GitRepository | null;
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}

interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly HEAD: GitBranch | undefined;
    readonly remotes: readonly { readonly name: string }[];
  };
  readonly ui: { readonly selected: boolean };
  getBranchBase?(name: string): Promise<GitBranch | undefined>;
  getCommit(ref: string): Promise<unknown>;
  getMergeBase(ref1: string, ref2: string): Promise<string | undefined>;
  getRefs(query: Record<string, never>): Promise<GitRef[]>;
  diffBetween(ref1: string, ref2: string): Promise<GitChange[]>;
}

interface GitRef {
  readonly type: GitRefType;
  readonly name?: string;
  readonly remote?: string;
}

interface GitBranch extends GitRef {
  readonly commit?: string;
  readonly upstream?: {
    readonly remote: string;
    readonly name: string;
  };
}

interface GitChange {
  readonly uri: vscode.Uri;
  readonly originalUri: vscode.Uri;
  readonly status: GitStatus;
}

const enum GitRefType {
  Head = 0,
  RemoteHead = 1
}

const enum GitStatus {
  IndexAdded = 1,
  IndexDeleted = 2,
  IndexRenamed = 3,
  IndexCopied = 4,
  Deleted = 6
}
