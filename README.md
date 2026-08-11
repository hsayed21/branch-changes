<p align="center">
  <img src="icon.png" width="96" alt="Branch Changes icon">
</p>

# Branch Changes

Open all committed changes on the current Git branch in VS Code's native
Changes editor—without requiring a pull request or GitLens Pro.

## Use

1. Open **Source Control**.
2. Click **Show Branch Changes** on the Git repository title row.
3. Review the cumulative diff from the branch base to `HEAD`.

If the detected base is wrong, run **Branch Changes: Set Base Branch...**. Pick
the repository first, then its base branch. The selection is saved per
repository and current branch.

Only committed changes are included.

## Commands

- **Branch Changes: Show Branch Changes**
- **Branch Changes: Set Base Branch...**

## Settings

```json
{
  "branchChanges.baseBranch": "origin/develop",
  "branchChanges.fallbackBaseBranches": ["develop", "main", "master"]
}
```

## Development

```powershell
npm ci
npm run compile
```

Press `F5` to open an Extension Development Host.

## Release

Run the **Release** workflow and choose `patch`, `minor`, or `major`. Publishing
to the VS Code Marketplace requires a repository secret named `VSCE_PAT`.
