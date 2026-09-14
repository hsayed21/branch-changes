<p align="center">
  <img src="icon.png" width="96" alt="Branch Changes icon">
</p>

# Branch Changes

Open all committed changes on the current Git branch in VS Code's native
Changes editor—without requiring a pull request or GitLens Pro.

## Use

1. Open **Source Control**.
2. Expand the **Branch Changes** tree view to browse committed changes on the
   current branch.
3. Click a file to open a single-file diff (merge-base ↔ HEAD).
4. Click **Show Branch Changes** on the Git repository title row to open all
   diffs in VS Code's native Changes editor at once.

If the detected base is wrong, run **Branch Changes: Set Base Branch...**. Pick
the repository first, then its base branch. The selection is saved per
repository and current branch.

Only committed changes are included.

## Branch Changes tree

The **Branch Changes** view appears under Source Control. It lists every file
changed on the current branch relative to the base ref, grouped by folder.

### Review tracking

- **Mark as Reviewed** / **Mark as Unreviewed** — inline checkmark on each file
  row. Reviewed files get a soft green name tint; the status icon and letter
  stay the same.
- While a change diff is open, the editor title bar shows **Mark as Reviewed**,
  **Next Unreviewed File**, and **Previous Unreviewed File**.
- While a change diff is open in the editor, run **Branch Changes: Mark as
  Reviewed** (default: `Ctrl+Alt+R` / `Cmd+Alt+R` on macOS) to mark that open
  file. With **Open Next on Reviewed** enabled (default), the next unreviewed
  file opens automatically. Use **Next Unreviewed File** (`Ctrl+Alt+N` /
  `Cmd+Alt+N`) or **Previous Unreviewed File** (`Ctrl+Alt+P` / `Cmd+Alt+P`) to
  jump without marking.
- Rebind the shortcuts in **Keyboard Shortcuts** by searching for
  `Branch Changes: Mark as Reviewed`, `Next Unreviewed File`, or
  `Previous Unreviewed File`.
- With **Sort Reviewed to Bottom** enabled (default), marking a file reviewed
  moves it to the bottom and keeps unreviewed files on top.
- Review state is stored in workspace storage, keyed by repository and branch
  name. Each reviewed file also stores a hash of its HEAD content; if that file
  changes in a later commit, it becomes **Unreviewed** again automatically.
  Switching branches loads that branch's review state; files that leave the
  change set are pruned automatically.
- Folder rows show a `reviewed/total` count (for example `2/5`).
- **Clear Review Marks** resets every reviewed mark for the current branch
  (no confirmation; you can mark files again).

### View title actions

| Action | Description |
|---|---|
| **Refresh** | Reload the change list from Git |
| **View as List** / **View as Tree** | Flat file list or folder tree (saved across VS Code restarts) |
| **Filter...** | Pick **All**, **Unreviewed**, or **Reviewed** (saved across VS Code restarts) |
| **Open All Diffs** | Open the full multi-file Changes editor (`vscode.changes`) |
| **Clear Review Marks** | Clear all reviewed marks for the current branch (⋯ menu) |

## Commands

- **Branch Changes: Show Branch Changes**
- **Branch Changes: Set Base Branch...**
- **Branch Changes: Refresh**
- **Branch Changes: Open All Diffs**
- **Branch Changes: View as List**
- **Branch Changes: View as Tree**
- **Branch Changes: Filter...**
- **Branch Changes: Mark as Reviewed**
- **Branch Changes: Mark as Unreviewed**
- **Branch Changes: Next Unreviewed File**
- **Branch Changes: Previous Unreviewed File**
- **Branch Changes: Clear Review Marks**

## Settings

```json
{
  "branchChanges.baseBranch": "origin/develop",
  "branchChanges.fallbackBaseBranches": ["develop", "main", "master"],
  "branchChanges.sortReviewedToBottom": true,
  "branchChanges.openNextOnReviewed": true
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
