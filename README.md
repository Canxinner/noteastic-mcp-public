# Noteastic MCP

A local MCP server for backups created by the [Noteastic](https://noteastic.app/en/) Windows app. It reads backups without modifying them and exports pages or notebooks as PDF and PNG on explicit tool calls.

This is an unofficial, independent project and is not affiliated with the Noteastic publisher.

## Features

- Browse folders and notebooks, and search their names.
- Compare backups to identify added, changed, and removed folders, notebooks, and pages.
- Inspect notebook pages and locate embedded PDF and image assets.
- Export individual pages or complete notebooks as PDF and/or PNG.
- Render handwriting, highlights, lines, shapes, text, images, and PDF backgrounds locally.
- Reload the latest `.ntcbak` file when a new backup appears.

Handwriting is stored as pen data. Searching handwritten content requires separate OCR, which is not included. Backup comparisons use metadata and element counts, not a semantic comparison of page contents. MCP tool descriptions and error messages currently use German.

## Installation

Requirements: Git and Node.js 22.13.0 or newer. The existing tests were verified on Node.js 26.2.0 on Windows; other versions have not been verified here.

```powershell
git clone https://github.com/Canxinner/noteastic-mcp-public.git
cd noteastic-mcp-public
npm ci
npm test
```

## Connect to Codex

1. In Noteastic, open **Settings → Backup** and save a current `.ntcbak` file in a dedicated backup folder. This server does not create backups.
2. Run the following command in PowerShell, replacing all example paths with your actual folders:

```powershell
codex mcp add noteastic --env "NOTEASTIC_BACKUP_DIR=C:\path\to\backups" --env "NOTEASTIC_EXPORT_DIR=C:\path\to\exports" -- node "C:\path\to\noteastic-mcp-public\src\index.js"
```

3. Restart Codex to load the connection.

## Configuration

- `NOTEASTIC_BACKUP_DIR`: folder containing backups; the latest file is selected by modification time.
- `NOTEASTIC_BACKUP_PATH`: use a specific backup instead of selecting from a folder.
- `NOTEASTIC_EXPORT_DIR`: destination for exported files. Defaults to a `Noteastic Exports` folder inside the backup directory, or next to the selected backup file.

To run the server directly:

```powershell
$env:NOTEASTIC_BACKUP_DIR = 'C:\path\to\backups'
$env:NOTEASTIC_EXPORT_DIR = 'C:\path\to\exports'
npm start
```

The server communicates over standard input/output (stdio).

## Tools

| Tool | Purpose |
| --- | --- |
| `backup_info` | Inspect the active backup and its metadata. |
| `list_library` | List folders and notebooks. |
| `search_library` | Search folder and notebook names. |
| `get_notebook` | Get notebook metadata and its page list. |
| `get_page_assets` | List PDF and image assets associated with a page. |
| `export_page` | Export a `pageId` as `png`, `pdf`, or `both`. |
| `export_notebook` | Export a `notebookId` as `pdf`, `png`, or `both`. |
| `changes_since_backup` | Compare the current backup with an older backup. |

Export tools return the created local file paths and accept `scale` from 1 to 3 (default: 2).

## Backup comparison

By default, `changes_since_backup` compares the latest backup with the previous one in the configured folder. Use `baselinePath` to select a specific older `.ntcbak` file.

The result includes:

- `newNotebooks`, `changedNotebooks`, and `removedNotebooks`.
- `newFolders`, `changedFolders`, and `removedFolders`.
- `pageChanges` as a compact summary. Set `includePages: true` to also receive `newPages`, `changedPages`, and `removedPages`.

Notebook metadata includes `createdAt`, `updatedAt`, `folderPath`, and `pageCount`. Folders do not have a `LastEdited` field in the database: their `detectedAt` value is the backup observation time, not the exact edit time.

## Privacy and limitations

Tool responses send notebook names, metadata, and file paths to the connected AI client. That client's settings determine further processing. Exported PDF and PNG files remain local; export tools return their paths rather than the file contents.

Keep backups, exports, databases, and credentials out of Git. Reading a backup creates a temporary database copy, which may currently remain after the server exits. Only use backups you trust.

The dependency audit currently reports unresolved advisories. Passing functional tests does not establish that those advisories are harmless in this application.

## License

The MCP code is available under the [MIT License](LICENSE). Dependencies retain their own licenses.
