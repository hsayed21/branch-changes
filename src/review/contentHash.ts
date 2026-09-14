import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { GitApi, GitChange, GitStatus } from '../git/gitApi';

export function hashBytes(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Hash of the file content at HEAD (the tip of the branch being reviewed).
 * Deleted files use a stable sentinel so a re-add counts as a new review.
 */
export async function hashChangeAtHead(
  git: GitApi,
  change: GitChange,
  headRef: string
): Promise<string> {
  if (
    change.status === GitStatus.IndexDeleted ||
    change.status === GitStatus.Deleted
  ) {
    return 'deleted';
  }

  const gitUri = git.toGitUri(change.uri, headRef);
  const bytes = await vscode.workspace.fs.readFile(gitUri);
  return hashBytes(bytes);
}
