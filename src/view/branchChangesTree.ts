import * as vscode from 'vscode';
import { findBaseBranch } from '../git/baseBranch';
import {
  FileChangeStats,
  displayChangeCounts,
  formatChangeStatsDescription,
  loadChangeStats,
  normalizeGitDiffAlgorithm
} from '../git/changeStats';
import { createChangeResource, diffUrisForChange } from '../git/changeResources';
import {
  getGitApi,
  GitApi,
  GitChange,
  GitRepository,
  GitStatus,
  repositoryDisplayName,
  waitForGitInitialized
} from '../git/gitApi';
import {
  activateGitSourceControl,
  pickRepository,
  SELECTED_REPO_KEY,
  selectRepository
} from '../git/repositorySelection';
import {
  buildChangeTree,
  ChangeFolderNode,
  ChangeNode,
  FileChangeInput,
  filterChangeTree,
  flattenChangeFiles,
  formatListPathLabel,
  ReviewFilter,
  shouldExpandFolder,
  toPosixRelativePath,
  ViewMode
} from '../model/changeTreeModel';
import { hashChangeAtHead } from '../review/contentHash';
import { ReviewState } from '../review/reviewState';
import { ReviewDecorationProvider, toBranchChangesUri } from './reviewDecorations';

const VIEW_MODE_KEY = 'branchChanges.viewMode';
const REVIEW_FILTER_KEY = 'branchChanges.reviewFilter';

interface FileRuntime {
  readonly gitChange: GitChange;
  readonly stats: FileChangeStats;
}

interface RepositoryStateWithEvents {
  readonly onDidChange: vscode.Event<void>;
}

export class BranchChangesTreeProvider
  implements vscode.TreeDataProvider<ChangeNode>, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<
    ChangeNode | undefined | null | void
  >();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly fileRuntime = new Map<string, FileRuntime>();
  /**
   * Last Branch Changes file we successfully resolved from an editor/tab.
   * Kept across brief focus loss (e.g. clicking the editor-title Mark Reviewed
   * button) so mark/unmark still has a target when activeTextEditor is cleared.
   */
  private lastActiveChangeRelativePath: string | undefined;

  private reviewFilter: ReviewFilter;
  private viewMode: ViewMode;
  private pathQuery = '';
  private pathSearchBox: vscode.InputBox | undefined;
  private root: ChangeFolderNode | undefined;
  private reviewState: ReviewState | undefined;
  private reviewStateKey: string | undefined;

  private git: GitApi | undefined;
  private repository: GitRepository | undefined;
  private mergeBase: string | undefined;
  private headRef: string | undefined;
  private baseRef: string | undefined;
  private headName: string | undefined;
  private changes: GitChange[] | undefined;

  private boundRepository: GitRepository | undefined;
  private repositorySubscription: vscode.Disposable | undefined;
  private readonly uiSubscriptions = new Map<string, vscode.Disposable>();
  private gitApiWired = false;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private treeView: vscode.TreeView<ChangeNode> | undefined;
  /** Bumped to drop stale TreeView selection handles when repainting a visible tree. */
  private treeGeneration = 0;
  /** True when model changed while the tree was hidden — repaint on next show. */
  private treeDirtyWhileHidden = false;
  private readonly listPathPartsStatusBar: vscode.StatusBarItem;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly decorations: ReviewDecorationProvider
  ) {
    this.viewMode = loadViewMode(readUiPref(context, VIEW_MODE_KEY));
    this.reviewFilter = loadReviewFilter(readUiPref(context, REVIEW_FILTER_KEY));
    this.listPathPartsStatusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.listPathPartsStatusBar.command = 'branchChanges.setListPathParts';
    this.listPathPartsStatusBar.tooltip =
      'Branch Changes: path segments shown in list view (click to change)';
    void this.syncViewModeContext();
    void this.syncReviewFilterContext();
    void this.syncPathSearchContext();
    // Promote legacy workspace prefs into globalState without waiting on activate.
    void migrateUiPrefs(context, this.viewMode, this.reviewFilter);
    this.disposables.push(
      this.listPathPartsStatusBar,
      vscode.workspace.onDidChangeConfiguration(event => {
        if (
          event.affectsConfiguration('branchChanges.sortReviewedToBottom') ||
          event.affectsConfiguration('branchChanges.sortByStatus') ||
          event.affectsConfiguration('branchChanges.sortByChanges') ||
          event.affectsConfiguration('branchChanges.gitDiffAlgorithm')
        ) {
          void this.refresh(undefined, { allowPick: false });
        }
        if (
          event.affectsConfiguration('branchChanges.listPathParts')
        ) {
          this.updateListPathPartsStatusBar();
          this.notifyTreeIfVisible();
        }
        if (event.affectsConfiguration('branchChanges.showMovedLineChanges')) {
          this.notifyTreeIfVisible();
        }
        if (event.affectsConfiguration('branchChanges.diffEditorAlgorithm')) {
          void this.applyDiffEditorAlgorithm();
        }
      }),
      vscode.window.onDidChangeActiveTextEditor(() => {
        void this.syncActiveChangeContext();
      }),
      vscode.window.tabGroups.onDidChangeTabs(() => {
        void this.syncActiveChangeContext();
      }),
      vscode.window.tabGroups.onDidChangeTabGroups(() => {
        void this.syncActiveChangeContext();
      })
    );
    this.updateListPathPartsStatusBar();
    void this.applyDiffEditorAlgorithm();
  }

  attachTreeView(treeView: vscode.TreeView<ChangeNode>): void {
    this.treeView = treeView;
    this.disposables.push(
      treeView.onDidChangeVisibility(event => {
        if (event.visible && this.treeDirtyWhileHidden) {
          this.treeDirtyWhileHidden = false;
          this.changeEmitter.fire();
        }
      })
    );
  }

  getViewMode(): ViewMode {
    return this.viewMode;
  }

  async setViewMode(mode: ViewMode): Promise<void> {
    if (this.viewMode === mode) {
      return;
    }
    this.viewMode = mode;
    await writeUiPref(this.context, VIEW_MODE_KEY, mode);
    await this.syncViewModeContext();
    this.updateListPathPartsStatusBar();
    this.changeEmitter.fire();
  }

  getReviewFilter(): ReviewFilter {
    return this.reviewFilter;
  }

  async setReviewFilter(filter: ReviewFilter): Promise<void> {
    if (this.reviewFilter === filter) {
      return;
    }
    this.reviewFilter = filter;
    await writeUiPref(this.context, REVIEW_FILTER_KEY, filter);
    await this.syncReviewFilterContext();
    this.changeEmitter.fire();
  }

  async pickReviewFilter(): Promise<void> {
    type FilterItem = vscode.QuickPickItem & { filter: ReviewFilter };
    const items: FilterItem[] = [
      {
        label: 'All',
        description: 'Show every changed file',
        filter: 'all',
        picked: this.reviewFilter === 'all'
      },
      {
        label: 'Unreviewed',
        description: 'Hide reviewed files',
        filter: 'unreviewed',
        picked: this.reviewFilter === 'unreviewed'
      },
      {
        label: 'Reviewed',
        description: 'Hide unreviewed files',
        filter: 'reviewed',
        picked: this.reviewFilter === 'reviewed'
      }
    ];

    const selected = await vscode.window.showQuickPick(items, {
      title: 'Branch Changes filter',
      placeHolder: `Current: ${filterLabel(this.reviewFilter)}`
    });
    if (selected) {
      await this.setReviewFilter(selected.filter);
    }
  }

  async pickAndOpenFile(): Promise<void> {
    if (this.pathSearchBox) {
      this.pathSearchBox.show();
      return;
    }

    if (!this.root) {
      await this.refresh(undefined, { allowPick: false });
    }

    const box = vscode.window.createInputBox();
    this.pathSearchBox = box;
    box.title = 'Search Branch Changes';
    box.placeholder = 'Type to filter files (e.g. customer)';
    box.value = this.pathQuery;
    box.ignoreFocusOut = true;
    box.buttons = [
      {
        iconPath: new vscode.ThemeIcon('clear-all'),
        tooltip: 'Clear search'
      }
    ];

    const updateFromValue = (value: string): void => {
      this.setPathQuery(value);
      const visible = this.getDisplayRoot();
      const count = visible?.totalFiles ?? 0;
      box.prompt =
        value.trim().length === 0
          ? 'Showing all files'
          : `${count} file${count === 1 ? '' : 's'} match "${value.trim()}"`;
    };

    box.onDidChangeValue(updateFromValue);
    box.onDidAccept(() => {
      box.hide();
      this.disposePathSearchBox();
    });
    box.onDidHide(() => {
      this.disposePathSearchBox();
    });
    box.onDidTriggerButton(() => {
      box.value = '';
      updateFromValue('');
      box.hide();
      this.disposePathSearchBox();
    });

    box.show();
    updateFromValue(box.value);
  }

  async clearPathSearch(): Promise<void> {
    this.setPathQuery('');
    if (this.pathSearchBox) {
      this.pathSearchBox.value = '';
      this.pathSearchBox.hide();
      this.disposePathSearchBox();
    }
  }

  async pickListPathParts(): Promise<void> {
    type PartsItem = vscode.QuickPickItem & { parts: number };
    const current = this.listPathParts();
    const example =
      'ClientApp/src/app/components/settings/Branches/add-branch/add-branch.component.html';
    const presets = [0, 2, 3, 4, 5, 6, 8];
    const items: PartsItem[] = presets.map(parts => ({
      label: parts === 0 ? 'Full path' : `${parts}`,
      description:
        parts === 0
          ? 'Show the entire relative path'
          : formatListPathLabel(example, parts),
      parts,
      picked: current === parts
    }));
    items.push({
      label: 'Custom...',
      description: 'Enter a number (0 = full path)',
      parts: -1
    });

    const selected = await vscode.window.showQuickPick(items, {
      title: 'List path parts',
      placeHolder: `Current: ${current <= 0 ? 'Full' : current}`
    });
    if (!selected) {
      return;
    }

    let value = selected.parts;
    if (value < 0) {
      const input = await vscode.window.showInputBox({
        title: 'List path parts',
        prompt: 'Number of trailing path segments to show (0 = full path)',
        value: String(current),
        validateInput: text => {
          const trimmed = text.trim();
          if (!/^\d+$/.test(trimmed)) {
            return 'Enter a non-negative integer';
          }
          return undefined;
        }
      });
      if (input === undefined) {
        return;
      }
      value = Number.parseInt(input.trim(), 10);
    }

    await vscode.workspace
      .getConfiguration('branchChanges')
      .update('listPathParts', value, vscode.ConfigurationTarget.Global);
  }

  /** Quick-pick a repository when the workspace has more than one. */
  async pickRepository(): Promise<void> {
    const git = await getGitApi();
    this.watchGitApi(git);
    await this.syncMultiRepoContext(git);

    if (git.repositories.length === 0) {
      void vscode.window.showInformationMessage(
        'Branch Changes: No Git repository is open.'
      );
      return;
    }

    if (git.repositories.length === 1) {
      await this.applyRepositorySelection(git.repositories[0]);
      return;
    }

    const currentUri = this.repository?.rootUri.toString();
    const selected = await pickRepository(
      git.repositories,
      currentUri
        ? `Select repository (current: ${repositoryDisplayName(this.repository!)})`
        : 'Select a Git repository',
      currentUri
    );
    if (!selected) {
      return;
    }

    await this.applyRepositorySelection(selected);
  }

  /**
   * Persist the repo as the Branch Changes / Git source, sync SCM when possible,
   * and refresh the file list.
   */
  private async applyRepositorySelection(
    repository: GitRepository
  ): Promise<void> {
    await this.context.workspaceState.update(
      SELECTED_REPO_KEY,
      repository.rootUri.toString()
    );
    this.repository = repository;
    await activateGitSourceControl(repository);
    await this.refresh(repository, { allowPick: false });
  }

  async refresh(
    preferredRepository?: GitRepository,
    options?: { allowPick?: boolean }
  ): Promise<void> {
    const allowPick = options?.allowPick ?? true;
    try {
      const git = await getGitApi();
      this.watchGitApi(git);
      await waitForGitInitialized(git);
      await this.syncMultiRepoContext(git);

      const repository = await this.resolveRepositoryForRefresh(
        git,
        preferredRepository,
        allowPick
      );
      if (!repository) {
        const saved = this.context.workspaceState.get<string>(SELECTED_REPO_KEY);
        this.resetChangeData();
        this.repository = undefined;
        this.setMessage(
          saved
            ? 'Waiting for the saved Git repository…'
            : git.repositories.length > 1
              ? 'Select a Git repository to see branch changes.'
              : 'No Git repository selected.'
        );
        this.updateTreeDescription(git);
        this.changeEmitter.fire();
        await this.syncActiveChangeContext();
        return;
      }

      this.repository = repository;
      // Persist only the repo we are actually showing (including restored saved).
      await this.context.workspaceState.update(
        SELECTED_REPO_KEY,
        repository.rootUri.toString()
      );
      this.bindRepository(repository);
      this.updateTreeDescription(git);

      const head = repository.state.HEAD;
      if (!head?.name) {
        this.resetChangeData();
        this.setMessage('Check out a branch to see branch changes.');
        this.changeEmitter.fire();
        await this.syncActiveChangeContext();
        return;
      }

      const base = await findBaseBranch(this.context, repository, head);
      if (!base) {
        this.resetChangeData();
        this.setMessage('Set a base branch to see branch changes.');
        this.changeEmitter.fire();
        await this.syncActiveChangeContext();
        return;
      }

      const headRef = head.commit ?? 'HEAD';
      const mergeBase = await repository.getMergeBase(base.ref, headRef);
      if (!mergeBase) {
        this.resetChangeData();
        this.setMessage(
          `No common ancestor was found between ${base.ref} and ${head.name}.`
        );
        this.changeEmitter.fire();
        await this.syncActiveChangeContext();
        return;
      }

      const changes = await repository.diffBetween(mergeBase, headRef);
      let changeStats = new Map<string, FileChangeStats>();
      try {
        changeStats = await loadChangeStats(
          repository.rootUri.fsPath,
          mergeBase,
          headRef,
          this.gitDiffAlgorithm()
        );
      } catch {
        // Counts are best-effort; the tree still works without them.
      }

      const files: FileChangeInput[] = [];
      const activeHashes = new Map<string, string>();

      this.fileRuntime.clear();
      for (const change of changes) {
        const relativePath = toPosixRelativePath(
          repository.rootUri.fsPath,
          change.uri.fsPath
        );
        const contentHash = await hashChangeAtHead(git, change, headRef);
        activeHashes.set(relativePath, contentHash);
        const stats = changeStats.get(relativePath) ?? {
          additions: 0,
          deletions: 0,
          binary: false
        };
        files.push({
          relativePath,
          status: change.status,
          additions: stats.additions,
          deletions: stats.deletions,
          contentAdditions: stats.contentAdditions,
          contentDeletions: stats.contentDeletions,
          binary: stats.binary
        });
        this.fileRuntime.set(relativePath, { gitChange: change, stats });
      }

      const reviewStateKey = `${repository.rootUri.toString()}:${head.name}`;
      if (this.reviewStateKey !== reviewStateKey) {
        this.reviewState = new ReviewState(
          this.context.workspaceState,
          repository.rootUri.toString(),
          head.name
        );
        this.reviewStateKey = reviewStateKey;
      }

      await this.reviewState!.reconcile(activeHashes);
      this.root = buildChangeTree(files, this.reviewState!.getReviewedPaths(), {
        ...this.sortOptions()
      });
      this.decorations.setReviewedPaths(this.reviewState!.getReviewedPaths());

      this.git = git;
      this.repository = repository;
      this.mergeBase = mergeBase;
      this.headRef = headRef;
      this.baseRef = base.ref;
      this.headName = head.name;
      this.changes = changes;

      if (changes.length === 0) {
        this.setMessage(`No committed changes from ${base.ref}.`);
      } else {
        this.clearMessage();
      }

      this.changeEmitter.fire();
      await this.syncActiveChangeContext();
    } catch (error) {
      this.resetSnapshot();
      this.setMessage(error instanceof Error ? error.message : String(error));
      this.changeEmitter.fire();
      await this.syncActiveChangeContext();
    }
  }

  async toggleReviewed(
    node?: ChangeNode | vscode.Uri | string | readonly vscode.Uri[]
  ): Promise<void> {
    const file = this.resolveFileNode(node);
    if (!file) {
      void vscode.window.showInformationMessage(
        'Branch Changes: Open or select a changed file to mark as reviewed or unreviewed.'
      );
      return;
    }
    if (!this.reviewState || !this.git || !this.headRef) {
      return;
    }
    const runtime = this.fileRuntime.get(file.relativePath);
    if (!runtime) {
      return;
    }

    const markingReviewed = !this.reviewState.isReviewed(file.relativePath);
    const nextPath =
      markingReviewed && this.openNextOnReviewed()
        ? this.nextUnreviewedPath(file.relativePath)
        : undefined;

    let contentHash: string | undefined;
    if (markingReviewed) {
      contentHash = await hashChangeAtHead(
        this.git,
        runtime.gitChange,
        this.headRef
      );
    }
    await this.reviewState.toggle(file.relativePath, contentHash);

    // Rebuild in-memory model; only notify the tree when it is already visible
    // so a hidden sidebar stays hidden.
    this.rebuildRootFromRuntime();
    this.notifyTreeIfVisible();

    if (nextPath) {
      await this.openFileByPath(nextPath, { preview: true });
    } else {
      await this.syncActiveChangeContext();
    }
  }

  async openNextUnreviewed(): Promise<void> {
    await this.openAdjacentUnreviewed(1);
  }

  async openPreviousUnreviewed(): Promise<void> {
    await this.openAdjacentUnreviewed(-1);
  }

  /** Open a file diff from the tree (applies diffEditorAlgorithm first). */
  async openFileDiff(
    relativePath: string,
    options?: { preview?: boolean }
  ): Promise<void> {
    await this.openFileByPath(relativePath, options);
  }

  /** Apply Branch Changes diff editor algorithm setting to VS Code. */
  async ensureDiffEditorAlgorithm(): Promise<void> {
    await this.applyDiffEditorAlgorithm();
  }

  async clearMarks(): Promise<void> {
    if (!this.reviewState) {
      void vscode.window.showInformationMessage(
        'Branch Changes: No review marks to clear for the current branch.'
      );
      return;
    }
    const cleared = await this.reviewState.clearAll();
    if (cleared === 0) {
      void vscode.window.showInformationMessage(
        'Branch Changes: No review marks to clear for the current branch.'
      );
      return;
    }
    await this.refresh(undefined, { allowPick: false });
    void vscode.window.showInformationMessage(
      `Branch Changes: Cleared ${cleared} review mark${cleared === 1 ? '' : 's'}.`
    );
  }

  async openAllDiffs(): Promise<void> {
    if (
      !this.git ||
      !this.mergeBase ||
      !this.headRef ||
      !this.baseRef ||
      !this.headName ||
      !this.changes ||
      this.changes.length === 0
    ) {
      return;
    }

    const resources = this.changes.map(change =>
      createChangeResource(this.git!, change, this.mergeBase!, this.headRef!)
    );
    const title = `Changes in ${this.headName} from ${this.baseRef}`;
    await this.applyDiffEditorAlgorithm();
    await vscode.commands.executeCommand('vscode.changes', title, resources);
  }

  getTreeItem(element: ChangeNode): vscode.TreeItem {
    if (element.kind === 'folder') {
      return this.folderTreeItem(element);
    }
    return this.fileTreeItem(element);
  }

  getChildren(element?: ChangeNode): ChangeNode[] {
    const displayRoot = this.getDisplayRoot();
    if (!displayRoot) {
      return [];
    }
    if (this.viewMode === 'list') {
      if (element) {
        return [];
      }
      return flattenChangeFiles(this.root!, {
        filter: this.reviewFilter,
        pathQuery: this.pathQuery,
        ...this.sortOptions()
      });
    }
    if (!element) {
      return displayRoot.children;
    }
    if (element.kind === 'folder') {
      return element.children;
    }
    return [];
  }

  getParent(element: ChangeNode): ChangeNode | undefined {
    if (this.viewMode === 'list') {
      return undefined;
    }
    const displayRoot = this.getDisplayRoot();
    if (!displayRoot) {
      return undefined;
    }
    return findParent(displayRoot, element);
  }

  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.disposePathSearchBox();
    this.repositorySubscription?.dispose();
    for (const disposable of this.uiSubscriptions.values()) {
      disposable.dispose();
    }
    this.uiSubscriptions.clear();
    this.changeEmitter.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private folderTreeItem(folder: ChangeFolderNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      folder.name,
      shouldExpandFolder(folder, this.reviewFilter, this.pathQuery)
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
    );
    item.id = `d:${this.treeGeneration}:${folder.relativePath}`;
    item.contextValue = 'branchChangeFolder';
    item.description = `${folder.reviewedCount}/${folder.totalFiles}`;
    item.tooltip = `${folder.relativePath || folder.name} (${folder.reviewedCount}/${folder.totalFiles} reviewed)`;
    return item;
  }

  private fileTreeItem(file: ChangeFileNode): vscode.TreeItem {
    const label =
      this.viewMode === 'list'
        ? formatListPathLabel(file.relativePath, this.listPathParts())
        : (file.relativePath.split('/').pop() ?? file.relativePath);
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `f:${this.treeGeneration}:${file.relativePath}`;
    item.resourceUri = toBranchChangesUri(file.relativePath);
    item.contextValue = file.reviewed
      ? 'branchChangeFile:reviewed'
      : 'branchChangeFile:unreviewed';
    const includeMoved = this.showMovedLineChanges();
    const displayStats = {
      additions: file.additions,
      deletions: file.deletions,
      contentAdditions: file.contentAdditions,
      contentDeletions: file.contentDeletions,
      binary: file.binary
    };
    item.description = formatChangeStatsDescription(
      statusLetter(file.status),
      displayStats,
      includeMoved
    );
    item.iconPath = statusThemeIcon(file.status);
    if (file.binary) {
      item.tooltip = `${file.relativePath} (${statusLabel(file.status)}, binary)`;
    } else {
      const { additions, deletions } = displayChangeCounts(
        displayStats,
        includeMoved
      );
      item.tooltip = `${file.relativePath} (${statusLabel(file.status)}, ${additions + deletions} (+${additions} −${deletions}))`;
    }

    const command = this.openDiffCommand(file);
    if (command) {
      item.command = command;
    }

    return item;
  }

  private getDisplayRoot(): ChangeFolderNode | undefined {
    if (!this.root) {
      return undefined;
    }
    return filterChangeTree(this.root, this.reviewFilter, this.pathQuery);
  }

  private setPathQuery(value: string): void {
    if (this.pathQuery === value) {
      this.updatePathSearchDescription();
      return;
    }
    this.pathQuery = value;
    void this.syncPathSearchContext();
    this.updatePathSearchDescription();
    this.notifyTreeIfVisible();
  }

  private disposePathSearchBox(): void {
    this.pathSearchBox?.dispose();
    this.pathSearchBox = undefined;
  }

  private updatePathSearchDescription(): void {
    if (!this.treeView) {
      return;
    }
    const trimmed = this.pathQuery.trim();
    this.treeView.description = trimmed ? `Search: ${trimmed}` : undefined;
  }

  private async syncPathSearchContext(): Promise<void> {
    await vscode.commands.executeCommand(
      'setContext',
      'branchChanges.pathSearchActive',
      this.pathQuery.trim().length > 0
    );
  }

  private sortReviewedToBottom(): boolean {
    return vscode.workspace
      .getConfiguration('branchChanges')
      .get<boolean>('sortReviewedToBottom', true);
  }

  private sortByStatus(): boolean {
    return vscode.workspace
      .getConfiguration('branchChanges')
      .get<boolean>('sortByStatus', false);
  }

  private sortByChanges(): boolean {
    return vscode.workspace
      .getConfiguration('branchChanges')
      .get<boolean>('sortByChanges', false);
  }

  private showMovedLineChanges(): boolean {
    return vscode.workspace
      .getConfiguration('branchChanges')
      .get<boolean>('showMovedLineChanges', false);
  }

  private gitDiffAlgorithm() {
    return normalizeGitDiffAlgorithm(
      vscode.workspace
        .getConfiguration('branchChanges')
        .get<string>('gitDiffAlgorithm')
    );
  }

  private diffEditorAlgorithm(): 'legacy' | 'advanced' {
    const value = vscode.workspace
      .getConfiguration('branchChanges')
      .get<string>('diffEditorAlgorithm', 'advanced');
    return value === 'legacy' ? 'legacy' : 'advanced';
  }

  /**
   * Sync VS Code's diff editor algorithm from the Branch Changes setting.
   * vscode.diff cannot take an algorithm argument; it reads diffEditor.diffAlgorithm.
   */
  private async applyDiffEditorAlgorithm(): Promise<void> {
    const wanted = this.diffEditorAlgorithm();
    const config = vscode.workspace.getConfiguration('diffEditor');
    const current = config.get<string>('diffAlgorithm');
    if (current === wanted) {
      return;
    }
    const target =
      vscode.workspace.workspaceFolders &&
      vscode.workspace.workspaceFolders.length > 0
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    try {
      await config.update('diffAlgorithm', wanted, target);
    } catch {
      // Best-effort; opening the diff still works with the user's current setting.
    }
  }

  private sortOptions(): {
    sortReviewedToBottom: boolean;
    sortByStatus: boolean;
    sortByChanges: boolean;
  } {
    return {
      sortReviewedToBottom: this.sortReviewedToBottom(),
      sortByStatus: this.sortByStatus(),
      sortByChanges: this.sortByChanges()
    };
  }

  private openNextOnReviewed(): boolean {
    return vscode.workspace
      .getConfiguration('branchChanges')
      .get<boolean>('openNextOnReviewed', true);
  }

  private listPathParts(): number {
    const value = vscode.workspace
      .getConfiguration('branchChanges')
      .get<number>('listPathParts', 0);
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  }

  private updateListPathPartsStatusBar(): void {
    const parts = this.listPathParts();
    this.listPathPartsStatusBar.text =
      parts <= 0 ? 'Path Parts: Full' : `Path Parts: ${parts}`;
    if (this.viewMode === 'list') {
      this.listPathPartsStatusBar.show();
    } else {
      this.listPathPartsStatusBar.hide();
    }
  }

  private resolveFileNode(
    node?: ChangeNode | vscode.Uri | string | readonly vscode.Uri[]
  ): ChangeFileNode | undefined {
    if (node && typeof node === 'object' && 'kind' in node && node.kind === 'file') {
      return node;
    }

    if (typeof node === 'string' && node.length > 0) {
      const fromPath = this.fileNodeByRelativePath(node);
      if (fromPath) {
        return fromPath;
      }
    }

    for (const uri of commandArgUris(node)) {
      const relativePath = this.relativePathForOpenUri(uri);
      if (!relativePath) {
        continue;
      }
      const fromUri = this.fileNodeByRelativePath(relativePath);
      if (fromUri) {
        this.lastActiveChangeRelativePath = fromUri.relativePath;
        return fromUri;
      }
    }

    const fromEditor = this.fileFromActiveEditor();
    if (fromEditor) {
      this.lastActiveChangeRelativePath = fromEditor.relativePath;
      return fromEditor;
    }

    const selected = this.treeView?.selection.find(
      (entry): entry is ChangeFileNode => entry.kind === 'file'
    );
    if (selected) {
      return selected;
    }

    if (this.lastActiveChangeRelativePath) {
      return this.fileNodeByRelativePath(this.lastActiveChangeRelativePath);
    }

    return undefined;
  }

  private fileNodeByRelativePath(
    relativePath: string
  ): ChangeFileNode | undefined {
    if (!this.root) {
      return undefined;
    }
    return flattenChangeFiles(this.root, {
      ...this.sortOptions()
    }).find(entry => entry.relativePath === relativePath);
  }

  private fileFromActiveEditor(): ChangeFileNode | undefined {
    if (!this.root) {
      return undefined;
    }
    for (const uri of activeEditorUris()) {
      const relativePath = this.relativePathForOpenUri(uri);
      if (!relativePath) {
        continue;
      }
      const file = this.fileNodeByRelativePath(relativePath);
      if (file) {
        return file;
      }
    }
    return undefined;
  }

  private relativePathForOpenUri(uri: vscode.Uri): string | undefined {
    if (!this.repository) {
      return undefined;
    }

    const openRaw = uriPathForMatch(uri);
    const openPath = normalizeFsPath(openRaw);
    if (!openPath) {
      return undefined;
    }

    for (const [relativePath, runtime] of this.fileRuntime) {
      const change = runtime.gitChange;
      const diff =
        this.git && this.mergeBase && this.headRef
          ? diffUrisForChange(
              this.git,
              change,
              this.mergeBase,
              this.headRef
            )
          : undefined;
      const candidates = [
        change.uri,
        change.originalUri,
        diff?.left,
        diff?.right
      ];
      for (const candidate of candidates) {
        if (!candidate) {
          continue;
        }
        if (sameFilePath(uri, candidate)) {
          return relativePath;
        }
        const candidatePath = normalizeFsPath(uriPathForMatch(candidate));
        if (candidatePath && candidatePath === openPath) {
          return relativePath;
        }
      }
    }

    if (openRaw) {
      const relativePath = toPosixRelativePath(
        this.repository.rootUri.fsPath,
        openRaw
      );
      if (
        relativePath &&
        !relativePath.startsWith('..') &&
        !/^[a-zA-Z]:/.test(relativePath) &&
        this.fileRuntime.has(relativePath)
      ) {
        return relativePath;
      }
    }

    return undefined;
  }

  private dropTreeSelection(): void {
    this.treeGeneration += 1;
  }

  private rebuildRootFromRuntime(): void {
    if (!this.reviewState) {
      return;
    }
    const files: FileChangeInput[] = [];
    for (const [relativePath, runtime] of this.fileRuntime) {
      files.push({
        relativePath,
        status: runtime.gitChange.status,
        additions: runtime.stats.additions,
        deletions: runtime.stats.deletions,
        contentAdditions: runtime.stats.contentAdditions,
        contentDeletions: runtime.stats.contentDeletions,
        binary: runtime.stats.binary
      });
    }
    this.root = buildChangeTree(files, this.reviewState.getReviewedPaths(), {
      ...this.sortOptions()
    });
    this.decorations.setReviewedPaths(this.reviewState.getReviewedPaths());
  }

  /** Repaint the tree only when it is already showing — never force the sidebar open. */
  private notifyTreeIfVisible(): void {
    if (this.treeView?.visible) {
      this.dropTreeSelection();
      this.changeEmitter.fire();
      this.treeDirtyWhileHidden = false;
      return;
    }
    this.treeDirtyWhileHidden = true;
  }

  private async openAdjacentUnreviewed(direction: 1 | -1): Promise<void> {
    const current = this.resolveFileNode()?.relativePath;
    const targetPath = this.adjacentUnreviewedPath(current, direction);
    if (!targetPath) {
      void vscode.window.showInformationMessage(
        'Branch Changes: No unreviewed files remaining.'
      );
      return;
    }
    await this.openFileByPath(targetPath, { preview: true });
  }

  private nextUnreviewedPath(currentPath?: string): string | undefined {
    // Wrap so marking the last unreviewed file advances to the first remaining one.
    return this.adjacentUnreviewedPath(currentPath, 1, { wrap: true });
  }

  private adjacentUnreviewedPath(
    currentPath: string | undefined,
    direction: 1 | -1,
    options?: { wrap?: boolean }
  ): string | undefined {
    if (!this.root) {
      return undefined;
    }
    const unreviewed = flattenChangeFiles(this.root, {
      filter: 'unreviewed',
      ...this.sortOptions()
    });
    if (unreviewed.length === 0) {
      return undefined;
    }
    if (!currentPath) {
      return direction === 1
        ? unreviewed[0].relativePath
        : unreviewed[unreviewed.length - 1].relativePath;
    }

    const index = unreviewed.findIndex(file => file.relativePath === currentPath);
    if (index < 0) {
      return direction === 1
        ? unreviewed[0].relativePath
        : unreviewed[unreviewed.length - 1].relativePath;
    }

    const nextIndex = index + direction;
    if (nextIndex >= 0 && nextIndex < unreviewed.length) {
      return unreviewed[nextIndex].relativePath;
    }

    const wrap = options?.wrap ?? true;
    if (wrap && unreviewed.length > 1) {
      return direction === 1
        ? unreviewed[0].relativePath
        : unreviewed[unreviewed.length - 1].relativePath;
    }
    return undefined;
  }

  private async openFileByPath(
    relativePath: string,
    options?: { preview?: boolean }
  ): Promise<void> {
    if (!this.root) {
      return;
    }
    const file = flattenChangeFiles(this.root, {
      ...this.sortOptions()
    }).find(entry => entry.relativePath === relativePath);
    if (!file) {
      return;
    }

    const command = this.buildEditorOpenCommand(file, options);
    if (!command?.arguments) {
      return;
    }
    this.lastActiveChangeRelativePath = relativePath;
    await this.applyDiffEditorAlgorithm();
    await vscode.commands.executeCommand(command.command, ...command.arguments);
    await this.syncActiveChangeContext();
  }

  private async syncViewModeContext(): Promise<void> {
    await vscode.commands.executeCommand(
      'setContext',
      'branchChanges.viewMode',
      this.viewMode
    );
  }

  private async syncReviewFilterContext(): Promise<void> {
    await vscode.commands.executeCommand(
      'setContext',
      'branchChanges.reviewFilter',
      this.reviewFilter
    );
  }

  private async syncActiveChangeContext(): Promise<void> {
    const file = this.fileFromActiveEditor();
    if (file) {
      this.lastActiveChangeRelativePath = file.relativePath;
    } else if (vscode.window.activeTextEditor) {
      // A real non-change editor is focused — drop the sticky fallback.
      this.lastActiveChangeRelativePath = undefined;
    }
    // When activeTextEditor is missing (title-bar click), keep the sticky path.

    const active =
      file ??
      (this.lastActiveChangeRelativePath
        ? this.fileNodeByRelativePath(this.lastActiveChangeRelativePath)
        : undefined);

    await vscode.commands.executeCommand(
      'setContext',
      'branchChanges.activeChange',
      !!active
    );
    await vscode.commands.executeCommand(
      'setContext',
      'branchChanges.activeReviewed',
      !!active?.reviewed
    );
  }

  private openDiffCommand(
    file: ChangeFileNode,
    options?: { preview?: boolean }
  ): vscode.Command | undefined {
    const runtime = this.fileRuntime.get(file.relativePath);
    if (!runtime || !this.git || !this.mergeBase || !this.headRef) {
      return undefined;
    }

    const { left, right } = diffUrisForChange(
      this.git,
      runtime.gitChange,
      this.mergeBase,
      this.headRef
    );

    // Route through our command so diffEditorAlgorithm is applied first.
    if (left || right) {
      return {
        command: 'branchChanges.openFileDiff',
        title: 'Open Diff',
        arguments: [file.relativePath, options]
      };
    }
    return undefined;
  }

  /** Real vscode.diff / vscode.open command (no Branch Changes wrapper). */
  private buildEditorOpenCommand(
    file: ChangeFileNode,
    options?: { preview?: boolean }
  ): vscode.Command | undefined {
    const runtime = this.fileRuntime.get(file.relativePath);
    if (!runtime || !this.git || !this.mergeBase || !this.headRef) {
      return undefined;
    }

    const { left, right } = diffUrisForChange(
      this.git,
      runtime.gitChange,
      this.mergeBase,
      this.headRef
    );
    const title = file.relativePath;
    const openOptions =
      options?.preview === undefined ? undefined : { preview: options.preview };

    if (!left && right) {
      return {
        command: 'vscode.open',
        title: 'Open',
        arguments: openOptions ? [right, openOptions] : [right]
      };
    }
    if (left && !right) {
      return {
        command: 'vscode.open',
        title: 'Open',
        arguments: openOptions ? [left, openOptions] : [left]
      };
    }
    if (left && right) {
      return {
        command: 'vscode.diff',
        title: 'Open Diff',
        arguments: openOptions
          ? [left, right, title, openOptions]
          : [left, right, title]
      };
    }
    return undefined;
  }

  private watchGitApi(git: GitApi): void {
    if (this.gitApiWired) {
      return;
    }
    this.gitApiWired = true;
    this.git = git;

    for (const repository of git.repositories) {
      this.bindRepositoryUi(repository);
    }

    this.disposables.push(
      git.onDidOpenRepository(repository => {
        this.bindRepositoryUi(repository);
        void this.syncMultiRepoContext(git);
        const saved = this.context.workspaceState.get<string>(SELECTED_REPO_KEY);
        // As soon as the saved repo appears after reload, restore it and load files.
        if (saved && repository.rootUri.toString() === saved) {
          void this.refresh(repository, { allowPick: false });
          return;
        }
        if (!this.repository) {
          this.scheduleRefresh();
        }
      }),
      git.onDidCloseRepository(repository => {
        this.unbindRepositoryUi(repository);
        if (this.boundRepository === repository) {
          this.boundRepository = undefined;
          this.repositorySubscription?.dispose();
          this.repositorySubscription = undefined;
        }
        if (this.repository === repository) {
          this.repository = undefined;
        }
        void this.syncMultiRepoContext(git);
        this.scheduleRefresh();
      })
    );
  }

  private bindRepositoryUi(repository: GitRepository): void {
    const key = repository.rootUri.toString();
    if (this.uiSubscriptions.has(key)) {
      return;
    }

    this.uiSubscriptions.set(
      key,
      repository.ui.onDidChange(() => {
        if (!repository.ui.selected) {
          return;
        }
        // Follow the Git SCM selected source: save, then refresh the file list.
        if (
          this.repository?.rootUri.toString() === repository.rootUri.toString()
        ) {
          return;
        }
        void this.context.workspaceState
          .update(SELECTED_REPO_KEY, repository.rootUri.toString())
          .then(() => this.refresh(repository, { allowPick: false }));
      })
    );
  }

  private unbindRepositoryUi(repository: GitRepository): void {
    const key = repository.rootUri.toString();
    this.uiSubscriptions.get(key)?.dispose();
    this.uiSubscriptions.delete(key);
  }

  private bindRepository(repository: GitRepository): void {
    if (this.boundRepository === repository) {
      return;
    }

    this.repositorySubscription?.dispose();
    this.boundRepository = repository;

    const onDidChange = (repository.state as unknown as RepositoryStateWithEvents)
      .onDidChange;
    if (onDidChange) {
      this.repositorySubscription = onDidChange(() => this.scheduleRefresh());
    }
  }

  private scheduleRefresh(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      void this.refresh(undefined, { allowPick: false });
    }, 300);
  }

  /** Prefer the current / last-picked repo while it is still open. */
  private resolveStickyRepository(
    git: GitApi
  ): GitRepository | undefined {
    if (this.repository) {
      const stillOpen = git.repositories.find(
        entry =>
          entry.rootUri.toString() === this.repository!.rootUri.toString()
      );
      if (stillOpen) {
        return stillOpen;
      }
    }

    const saved = this.context.workspaceState.get<string>(SELECTED_REPO_KEY);
    if (!saved) {
      return undefined;
    }
    return git.repositories.find(entry => entry.rootUri.toString() === saved);
  }

  /**
   * Resolve which repo to show: preferred → saved/sticky → SCM selected →
   * single repo → optional quick-pick. Never picks a different repo while a
   * saved URI still exists but is not open yet (avoids clobbering on startup).
   */
  private async resolveRepositoryForRefresh(
    git: GitApi,
    preferredRepository: GitRepository | undefined,
    allowPick: boolean
  ): Promise<GitRepository | undefined> {
    if (preferredRepository) {
      const open = git.repositories.find(
        entry =>
          entry.rootUri.toString() === preferredRepository.rootUri.toString()
      );
      if (open) {
        return open;
      }
    }

    const sticky = this.resolveStickyRepository(git);
    if (sticky) {
      return sticky;
    }

    const saved = this.context.workspaceState.get<string>(SELECTED_REPO_KEY);
    // If a saved URI exists but is not open after Git finished initializing,
    // fall through to SCM / single-repo / pick rather than hanging forever.

    const scmSelected = git.repositories.find(entry => entry.ui.selected);
    if (scmSelected) {
      return scmSelected;
    }

    if (git.repositories.length === 1) {
      return git.repositories[0];
    }

    if (allowPick && git.repositories.length > 1) {
      return selectRepository(git, undefined, {
        savedRepositoryUri: saved
      });
    }

    return undefined;
  }

  private async syncMultiRepoContext(git: GitApi): Promise<void> {
    await vscode.commands.executeCommand(
      'setContext',
      'branchChanges.multiRepo',
      git.repositories.length > 1
    );
  }

  private updateTreeDescription(git: GitApi): void {
    if (!this.treeView) {
      return;
    }
    if (git.repositories.length > 1 && this.repository) {
      this.treeView.description = repositoryDisplayName(this.repository);
      return;
    }
    this.treeView.description = undefined;
  }

  /** Clear file list state but keep the selected repository. */
  private resetChangeData(): void {
    this.root = undefined;
    this.fileRuntime.clear();
    this.lastActiveChangeRelativePath = undefined;
    this.mergeBase = undefined;
    this.headRef = undefined;
    this.baseRef = undefined;
    this.headName = undefined;
    this.changes = undefined;
  }

  private resetSnapshot(): void {
    this.resetChangeData();
    this.git = undefined;
    this.repository = undefined;
  }

  private setMessage(message: string): void {
    if (this.treeView) {
      this.treeView.message = message;
    }
  }

  private clearMessage(): void {
    if (this.treeView) {
      this.treeView.message = undefined;
    }
  }
}

type ChangeFileNode = Extract<ChangeNode, { kind: 'file' }>;

function activeEditorUris(): vscode.Uri[] {
  const uris: vscode.Uri[] = [];

  // Prefer the focused editor first — title-bar clicks can clear it later, but
  // while it exists it is the best signal for multi-diff / nested editors.
  const editorUri = vscode.window.activeTextEditor?.document.uri;
  if (editorUri) {
    uris.push(editorUri);
  }

  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
  const input = tab?.input;
  if (input instanceof vscode.TabInputTextDiff) {
    uris.push(input.original, input.modified);
  } else if (input instanceof vscode.TabInputText) {
    uris.push(input.uri);
  }
  // Multi-diff tabs: do not expand every textDiff here — that would mark the
  // wrong file. Rely on activeTextEditor + lastActiveChangeRelativePath.

  return uris;
}

/** Collect URIs passed by editor/title or other menu invocations. */
function commandArgUris(arg: unknown): vscode.Uri[] {
  if (!arg) {
    return [];
  }
  if (arg instanceof vscode.Uri) {
    return [arg];
  }
  if (Array.isArray(arg)) {
    return arg.filter((entry): entry is vscode.Uri => entry instanceof vscode.Uri);
  }
  return [];
}

/** File path from file: or git: URIs (git stores the real path in the query). */
function uriPathForMatch(uri: vscode.Uri): string | undefined {
  if (uri.scheme === 'git' && uri.query) {
    try {
      const query = JSON.parse(uri.query) as { path?: string };
      if (typeof query.path === 'string' && query.path.length > 0) {
        return query.path;
      }
    } catch {
      // Fall through to fsPath / path.
    }
  }
  try {
    if (uri.fsPath) {
      return uri.fsPath;
    }
  } catch {
    // Some URI schemes do not support fsPath.
  }
  return uri.path || undefined;
}

function normalizeFsPath(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function sameFilePath(a: vscode.Uri, b: vscode.Uri): boolean {
  if (a.toString() === b.toString()) {
    return true;
  }
  const left = normalizeFsPath(uriPathForMatch(a));
  const right = normalizeFsPath(uriPathForMatch(b));
  return Boolean(left && right && left === right);
}

function findParent(
  folder: ChangeFolderNode,
  target: ChangeNode
): ChangeNode | undefined {
  for (const child of folder.children) {
    if (child === target) {
      return folder.relativePath === '' ? undefined : folder;
    }
    if (child.kind === 'folder') {
      const found = findParent(child, target);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

function loadViewMode(value: unknown): ViewMode {
  return value === 'list' ? 'list' : 'tree';
}

function loadReviewFilter(value: unknown): ReviewFilter {
  if (value === 'unreviewed' || value === 'reviewed' || value === 'all') {
    return value;
  }
  return 'all';
}

/** Prefer globalState so filter/view survive VS Code restarts across workspaces. */
function readUiPref(
  context: vscode.ExtensionContext,
  key: string
): unknown {
  const global = context.globalState.get(key);
  if (global !== undefined) {
    return global;
  }
  return context.workspaceState.get(key);
}

async function writeUiPref(
  context: vscode.ExtensionContext,
  key: string,
  value: string
): Promise<void> {
  await context.globalState.update(key, value);
  // Drop legacy workspace copy so old values cannot override after migrate.
  if (context.workspaceState.get(key) !== undefined) {
    await context.workspaceState.update(key, undefined);
  }
}

async function migrateUiPrefs(
  context: vscode.ExtensionContext,
  viewMode: ViewMode,
  reviewFilter: ReviewFilter
): Promise<void> {
  if (context.globalState.get(VIEW_MODE_KEY) === undefined) {
    await writeUiPref(context, VIEW_MODE_KEY, viewMode);
  } else if (context.workspaceState.get(VIEW_MODE_KEY) !== undefined) {
    await context.workspaceState.update(VIEW_MODE_KEY, undefined);
  }

  if (context.globalState.get(REVIEW_FILTER_KEY) === undefined) {
    await writeUiPref(context, REVIEW_FILTER_KEY, reviewFilter);
  } else if (context.workspaceState.get(REVIEW_FILTER_KEY) !== undefined) {
    await context.workspaceState.update(REVIEW_FILTER_KEY, undefined);
  }
}

function filterLabel(filter: ReviewFilter): string {
  switch (filter) {
    case 'unreviewed':
      return 'Unreviewed';
    case 'reviewed':
      return 'Reviewed';
    default:
      return 'All';
  }
}

function statusThemeIcon(status: number): vscode.ThemeIcon {
  switch (status) {
    case GitStatus.IndexAdded:
      return new vscode.ThemeIcon('diff-added');
    case GitStatus.IndexDeleted:
    case GitStatus.Deleted:
      return new vscode.ThemeIcon('diff-removed');
    case GitStatus.IndexRenamed:
      return new vscode.ThemeIcon('file-renamed');
    case GitStatus.IndexCopied:
      return new vscode.ThemeIcon('files');
    default:
      return new vscode.ThemeIcon('diff-modified');
  }
}

function statusLetter(status: number): string {
  switch (status) {
    case GitStatus.IndexAdded:
      return 'A';
    case GitStatus.IndexDeleted:
    case GitStatus.Deleted:
      return 'D';
    case GitStatus.IndexRenamed:
      return 'R';
    case GitStatus.IndexCopied:
      return 'C';
    default:
      return 'M';
  }
}

function statusLabel(status: number): string {
  switch (status) {
    case GitStatus.IndexAdded:
      return 'Added';
    case GitStatus.IndexDeleted:
    case GitStatus.Deleted:
      return 'Deleted';
    case GitStatus.IndexRenamed:
      return 'Renamed';
    case GitStatus.IndexCopied:
      return 'Copied';
    default:
      return 'Modified';
  }
}
