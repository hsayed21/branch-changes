import * as vscode from 'vscode';
import {
  branchRef,
  GitBranch,
  GitRef,
  GitRefType,
  GitRepository,
  isCurrentTrackingBranch,
  repositoryDisplayName
} from './gitApi';

export const STORAGE_PREFIX = 'branchChanges.base';

export interface BaseBranch {
  readonly ref: string;
}

export function baseStorageKey(repository: GitRepository, branchName: string): string {
  return `${STORAGE_PREFIX}:${repository.rootUri.toString()}:${branchName}`;
}

export async function findBaseBranch(
  context: vscode.ExtensionContext,
  repository: GitRepository,
  head: GitBranch
): Promise<BaseBranch | undefined> {
  const savedBase = context.workspaceState.get<string>(baseStorageKey(repository, head.name!));
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

export async function pickAndSaveBaseBranch(
  context: vscode.ExtensionContext,
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

  await context.workspaceState.update(baseStorageKey(repository, head.name!), picked.ref);
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

interface BaseQuickPickItem extends vscode.QuickPickItem {
  readonly ref: string;
}
