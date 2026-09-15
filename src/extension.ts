import * as vscode from 'vscode';
import { findBaseBranch, pickAndSaveBaseBranch } from './git/baseBranch';
import { createChangeResource } from './git/changeResources';
import { getGitApi, repositoryDisplayName } from './git/gitApi';
import { pickRepository, selectRepository } from './git/repositorySelection';
import { ChangeNode } from './model/changeTreeModel';
import { BranchChangesTreeProvider } from './view/branchChangesTree';
import { ReviewDecorationProvider } from './view/reviewDecorations';

export function activate(context: vscode.ExtensionContext): void {
  const decorations = new ReviewDecorationProvider();
  const provider = new BranchChangesTreeProvider(context, decorations);
  const treeView = vscode.window.createTreeView('branchChanges.files', {
    treeDataProvider: provider,
    showCollapseAll: true
  });
  provider.attachTreeView(treeView);

  context.subscriptions.push(
    provider,
    treeView,
    vscode.window.registerFileDecorationProvider(decorations),
    vscode.commands.registerCommand('branchChanges.show', (sourceControl?: unknown) =>
      runCommand(() => showBranchChanges(context, sourceControl))),
    vscode.commands.registerCommand('branchChanges.setBase', () =>
      runCommand(() => setBaseBranch(context, provider))),
    vscode.commands.registerCommand('branchChanges.refresh', () =>
      runCommand(() => provider.refresh())),
    vscode.commands.registerCommand('branchChanges.openAllDiffs', () =>
      runCommand(() => provider.openAllDiffs())),
    vscode.commands.registerCommand('branchChanges.filter', () =>
      runCommand(() => provider.pickReviewFilter())),
    vscode.commands.registerCommand('branchChanges.searchFiles', () =>
      runCommand(() => provider.pickAndOpenFile())),
    vscode.commands.registerCommand('branchChanges.clearPathSearch', () =>
      runCommand(() => provider.clearPathSearch())),
    vscode.commands.registerCommand('branchChanges.viewAsList', () =>
      runCommand(() => provider.setViewMode('list'))),
    vscode.commands.registerCommand('branchChanges.viewAsTree', () =>
      runCommand(() => provider.setViewMode('tree'))),
    vscode.commands.registerCommand('branchChanges.setListPathParts', () =>
      runCommand(() => provider.pickListPathParts())),
    vscode.commands.registerCommand('branchChanges.markReviewed', (node?: ChangeNode) =>
      runCommand(() => provider.toggleReviewed(node))),
    vscode.commands.registerCommand('branchChanges.markUnreviewed', (node?: ChangeNode) =>
      runCommand(() => provider.toggleReviewed(node))),
    vscode.commands.registerCommand('branchChanges.nextUnreviewed', () =>
      runCommand(() => provider.openNextUnreviewed())),
    vscode.commands.registerCommand('branchChanges.previousUnreviewed', () =>
      runCommand(() => provider.openPreviousUnreviewed())),
    vscode.commands.registerCommand('branchChanges.clearMarks', () =>
      runCommand(() => provider.clearMarks()))
  );

  void provider.refresh();
}

export function deactivate(): void {
  // Nothing to dispose beyond the subscriptions owned by VS Code.
}

async function showBranchChanges(
  context: vscode.ExtensionContext,
  sourceControl?: unknown
): Promise<void> {
  const git = await getGitApi();
  const repository = await selectRepository(git, sourceControl);
  if (!repository) {
    return;
  }

  const head = repository.state.HEAD;
  if (!head?.name) {
    throw new Error('Check out a branch before showing branch changes.');
  }

  let base = await findBaseBranch(context, repository, head);
  if (!base) {
    base = await pickAndSaveBaseBranch(context, repository, head);
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

async function setBaseBranch(
  context: vscode.ExtensionContext,
  provider: BranchChangesTreeProvider
): Promise<void> {
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

  const base = await pickAndSaveBaseBranch(context, repository, head);
  if (base) {
    void vscode.window.showInformationMessage(
      `Branch Changes: ${base.ref} is now the base for ${repositoryDisplayName(repository)} / ${head.name}.`
    );
    await provider.refresh(repository, { allowPick: false });
  }
}

async function runCommand(command: () => Promise<void>): Promise<void> {
  try {
    await command();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`Branch Changes: ${message}`);
  }
}
