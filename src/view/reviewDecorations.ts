import * as vscode from 'vscode';

export const BRANCH_CHANGES_SCHEME = 'branch-changes';

export function toBranchChangesUri(relativePath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: BRANCH_CHANGES_SCHEME, path: '/' + relativePath });
}

export function relativePathFromBranchChangesUri(uri: vscode.Uri): string | undefined {
  if (uri.scheme !== BRANCH_CHANGES_SCHEME) {
    return undefined;
  }
  return uri.path.replace(/^\//, '');
}

export class ReviewDecorationProvider implements vscode.FileDecorationProvider {
  private reviewed = new Set<string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;

  setReviewedPaths(paths: ReadonlySet<string>): void {
    this.reviewed = new Set(paths);
    this.emitter.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const path = relativePathFromBranchChangesUri(uri);
    if (!path || !this.reviewed.has(path)) {
      return undefined;
    }
    // Color tint only — keep the tree item's existing status icon / letter.
    return {
      tooltip: 'Reviewed',
      color: new vscode.ThemeColor('branchChanges.reviewedResourceForeground'),
      propagate: false
    };
  }
}
