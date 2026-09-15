import * as vscode from 'vscode';
import { GitApi, GitRepository, repositoryDisplayName } from './gitApi';

export const SELECTED_REPO_KEY = 'branchChanges.selectedRepository';

export async function selectRepository(
  git: GitApi,
  sourceControl?: unknown,
  options?: { savedRepositoryUri?: string }
): Promise<GitRepository | undefined> {
  const contextUri = sourceControlUri(sourceControl);
  const contextRepository = contextUri ? git.getRepository(contextUri) : null;
  if (contextRepository) {
    return contextRepository;
  }

  const savedUri = options?.savedRepositoryUri;
  if (savedUri) {
    const savedRepository = git.repositories.find(
      repository => repository.rootUri.toString() === savedUri
    );
    if (savedRepository) {
      return savedRepository;
    }
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

export async function pickRepository(
  repositories: readonly GitRepository[],
  placeHolder = 'Select a Git repository',
  currentUri?: string
): Promise<GitRepository | undefined> {
  if (repositories.length === 0) {
    throw new Error('No Git repository is open.');
  }

  const items = repositories.map<RepositoryQuickPickItem>(repository => {
    const isCurrent = currentUri === repository.rootUri.toString();
    return {
      label: repositoryDisplayName(repository),
      description: repository.state.HEAD?.name ?? 'No branch checked out',
      detail: repository.rootUri.fsPath,
      repository,
      picked: isCurrent,
      iconPath: isCurrent ? new vscode.ThemeIcon('check') : new vscode.ThemeIcon('repo')
    };
  });
  return (await vscode.window.showQuickPick(items, {
    placeHolder,
    matchOnDescription: true,
    matchOnDetail: true,
    title: 'Branch Changes repository'
  }))?.repository;
}

/**
 * Best-effort: make this repository the active Git / SCM source by focusing an
 * open editor that belongs to it (VS Code has no public setter for ui.selected).
 */
export async function activateGitSourceControl(
  repository: GitRepository
): Promise<void> {
  const rootPath = repository.rootUri.fsPath.replace(/\\/g, '/').toLowerCase();
  const matchesRepo = (uri: vscode.Uri): boolean => {
    if (uri.scheme !== 'file' && uri.scheme !== 'vscode-remote') {
      return false;
    }
    const path = uri.fsPath.replace(/\\/g, '/').toLowerCase();
    return path === rootPath || path.startsWith(`${rootPath}/`);
  };

  for (const editor of vscode.window.visibleTextEditors) {
    if (!matchesRepo(editor.document.uri)) {
      continue;
    }
    await vscode.window.showTextDocument(editor.document, {
      preview: true,
      preserveFocus: true,
      viewColumn: editor.viewColumn
    });
    return;
  }

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const uri = tabResourceUri(tab);
      if (!uri || !matchesRepo(uri)) {
        continue;
      }
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, {
          preview: true,
          preserveFocus: true,
          viewColumn: group.viewColumn
        });
        return;
      } catch {
        // Not a text document; keep looking.
      }
    }
  }
}

function tabResourceUri(tab: vscode.Tab): vscode.Uri | undefined {
  const input = tab.input;
  if (input instanceof vscode.TabInputText) {
    return input.uri;
  }
  if (input instanceof vscode.TabInputTextDiff) {
    return input.modified;
  }
  return undefined;
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

interface RepositoryQuickPickItem extends vscode.QuickPickItem {
  readonly repository: GitRepository;
}
