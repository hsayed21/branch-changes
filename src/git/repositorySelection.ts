import * as vscode from 'vscode';
import { GitApi, GitRepository, repositoryDisplayName } from './gitApi';

export async function selectRepository(
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

export async function pickRepository(
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
