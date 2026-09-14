import * as vscode from 'vscode';
import { GitApi, GitChange, GitStatus } from './gitApi';

export function createChangeResource(
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

export function diffUrisForChange(
  git: GitApi,
  change: GitChange,
  mergeBase: string,
  headRef: string
): { left: vscode.Uri | undefined; right: vscode.Uri | undefined } {
  switch (change.status) {
    case GitStatus.IndexAdded:
      return { left: undefined, right: git.toGitUri(change.uri, headRef) };
    case GitStatus.IndexDeleted:
    case GitStatus.Deleted:
      return { left: git.toGitUri(change.uri, mergeBase), right: undefined };
    case GitStatus.IndexRenamed:
    case GitStatus.IndexCopied:
      return {
        left: git.toGitUri(change.originalUri, mergeBase),
        right: git.toGitUri(change.uri, headRef)
      };
    default:
      return {
        left: git.toGitUri(change.uri, mergeBase),
        right: git.toGitUri(change.uri, headRef)
      };
  }
}
