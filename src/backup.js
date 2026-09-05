import AdmZip from "adm-zip";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";

const FOLDER_COMPARE_FIELDS = ["name", "color", "createdAt", "parentFolderId", "folderPath"];
const BOOK_COMPARE_FIELDS = ["name", "tagColor", "createdAt", "updatedAt", "folderId", "folderPath", "pageCount"];
const PAGE_COMPARE_FIELDS = ["bookId", "pageNumber", "width", "height", "backgroundColor", "createdAt", "gridType", "pdfPath", "elementCount", "strokeCount", "imageCount"];

function normalizeArchivePath(value) {
  return String(value ?? "").replaceAll("\\", "/").replace(/^\/+/, "");
}

function valuesEqual(field, left, right) {
  if (field === "pdfPath") return normalizeArchivePath(left) === normalizeArchivePath(right);
  return (left ?? null) === (right ?? null);
}

function buildFolderPathResolver(folders) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const memo = new Map();

  function folderPath(folderId, visited = new Set()) {
    if (folderId === null || folderId === undefined) return null;
    if (memo.has(folderId)) return memo.get(folderId);
    const folder = byId.get(folderId);
    if (!folder) return null;
    if (visited.has(folderId)) return folder.name;
    const nextVisited = new Set(visited);
    nextVisited.add(folderId);
    const parentPath = folderPath(folder.parentFolderId, nextVisited);
    const path = parentPath ? `${parentPath} / ${folder.name}` : folder.name;
    memo.set(folderId, path);
    return path;
  }

  return folderPath;
}

function compareRows(currentRows, previousRows, fields, detectedAt) {
  const currentById = new Map(currentRows.map((row) => [row.id ?? row.pageId, row]));
  const previousById = new Map(previousRows.map((row) => [row.id ?? row.pageId, row]));
  const added = [...currentById.entries()]
    .filter(([id]) => !previousById.has(id))
    .map(([, row]) => ({ ...row, detectedAt }));
  const removed = [...previousById.entries()]
    .filter(([id]) => !currentById.has(id))
    .map(([, row]) => ({ ...row, detectedAt }));
  const changed = [...currentById.entries()]
    .filter(([id]) => previousById.has(id))
    .map(([id, current]) => ({ id, current, previous: previousById.get(id) }))
    .map(({ id, current, previous }) => ({
      id,
      name: current.name ?? previous.name,
      folderPath: current.folderPath ?? previous.folderPath ?? null,
      changedFields: fields.filter((field) => !valuesEqual(field, current[field], previous[field])),
      previous,
      current,
      detectedAt
    }))
    .filter((change) => change.changedFields.length > 0);
  return { added, changed, removed };
}

function toPlainObject(row) {
  return Object.fromEntries(Object.entries(row));
}

function normalizeRows(rows) {
  return rows.map(toPlainObject);
}

export class NoteasticBackup {
  constructor({ backupPath, backupDirectory, exportDirectory } = {}) {
    if (!backupPath && !backupDirectory) {
      throw new Error("Es muss NOTEASTIC_BACKUP_PATH oder NOTEASTIC_BACKUP_DIR gesetzt sein.");
    }
    this.configuredBackupPath = backupPath;
    this.backupDirectory = backupDirectory;
    this.exportDirectory = exportDirectory ?? join(backupDirectory ?? dirname(backupPath), "Noteastic Exports");
    this.backupPath = undefined;
    this.archive = undefined;
    this.database = undefined;
    this.temporaryDirectory = undefined;
    this.version = undefined;
  }

  close() {
    this.database?.close();
    this.database = undefined;
    this.archive = undefined;
    this.version = undefined;
    if (this.temporaryDirectory) {
      rmSync(this.temporaryDirectory, { recursive: true, force: true });
      this.temporaryDirectory = undefined;
    }
  }

  ensureLoaded() {
    const backupPath = this.resolveBackupPath();
    const file = statSync(backupPath);
    const version = `${backupPath}:${file.size}:${file.mtimeMs}`;
    if (this.version === version && this.database && this.archive) return;

    this.close();
    const archive = new AdmZip(backupPath);
    const databaseEntry = archive.getEntry("noteastic.db");
    if (!databaseEntry) {
      throw new Error("Die Sicherung enthält keine noteastic.db-Datei.");
    }

    const temporaryDirectory = mkdtempSync(join(tmpdir(), "noteastic-mcp-"));
    const databasePath = join(temporaryDirectory, "noteastic.db");
    writeFileSync(databasePath, databaseEntry.getData());
    const database = new DatabaseSync(databasePath, { readOnly: true });
    this.archive = archive;
    this.database = database;
    this.temporaryDirectory = temporaryDirectory;
    this.backupPath = backupPath;
    this.version = version;
  }

  resolveBackupPath() {
    if (this.configuredBackupPath) return this.configuredBackupPath;
    const backups = this.listBackupCandidates();
    if (!backups[0]) {
      throw new Error(`Keine .ntcbak-Sicherung in ${this.backupDirectory} gefunden.`);
    }
    return backups[0].path;
  }

  listBackupCandidates() {
    if (!this.backupDirectory) return [];
    return readdirSync(this.backupDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && extname(entry.name).toLocaleLowerCase("en-US") === ".ntcbak")
      .map((entry) => {
        const path = join(this.backupDirectory, entry.name);
        return { path, modifiedAt: statSync(path).mtimeMs };
      })
      .sort((left, right) => right.modifiedAt - left.modifiedAt);
  }

  all(sql, ...parameters) {
    this.ensureLoaded();
    return normalizeRows(this.database.prepare(sql).all(...parameters));
  }

  get(sql, ...parameters) {
    this.ensureLoaded();
    const row = this.database.prepare(sql).get(...parameters);
    return row ? toPlainObject(row) : undefined;
  }

  getLibrary() {
    const folders = this.all(`
      SELECT f.ID AS id, f.Name AS name, f.Color AS color, f.CreationDate AS createdAt,
             relation.FolderID AS parentFolderId
      FROM Folder f
      LEFT JOIN FolderFolderContent relation ON relation.ChildFolderID = f.ID
      ORDER BY f.Name COLLATE NOCASE
    `);
    const books = this.all(`
      SELECT b.ID AS id, b.Name AS name, b.TagColor AS tagColor, b.CreationDate AS createdAt,
             b.LastEdited AS updatedAt, relation.FolderID AS folderId
      FROM Book b
      LEFT JOIN FolderBookContent relation ON relation.ChildBookID = b.ID
      ORDER BY b.Name COLLATE NOCASE
    `);
    return { folders, books };
  }

  getSnapshot() {
    const folders = this.all(`
      SELECT f.ID AS id, f.Name AS name, f.Color AS color, f.CreationDate AS createdAt,
             relation.FolderID AS parentFolderId
      FROM Folder f
      LEFT JOIN FolderFolderContent relation ON relation.ChildFolderID = f.ID
      ORDER BY f.Name COLLATE NOCASE
    `);
    const folderPath = buildFolderPathResolver(folders);
    const foldersWithPaths = folders.map((folder) => ({ ...folder, folderPath: folderPath(folder.id) }));

    const books = this.all(`
      SELECT b.ID AS id, b.Name AS name, b.TagColor AS tagColor, b.CreationDate AS createdAt,
             b.LastEdited AS updatedAt, relation.FolderID AS folderId
      FROM Book b
      LEFT JOIN FolderBookContent relation ON relation.ChildBookID = b.ID
      ORDER BY b.Name COLLATE NOCASE
    `);

    const pages = this.all(`
      SELECT bc.BookID AS bookId, bc.PageIndex + 1 AS pageNumber, p.ID AS pageId,
             p.Width AS width, p.Height AS height, p.BackgroundColor AS backgroundColor,
             p.CreationDate AS createdAt, g.GridType AS gridType, pdf.FilePath AS pdfPath,
             COUNT(CASE WHEN e.IsDeleted = 0 THEN 1 END) AS elementCount,
             COUNT(CASE WHEN s.ElementID IS NOT NULL AND e.IsDeleted = 0 THEN 1 END) AS strokeCount,
             COUNT(CASE WHEN i.ElementID IS NOT NULL AND e.IsDeleted = 0 THEN 1 END) AS imageCount
      FROM BookContent bc
      JOIN Page p ON p.ID = bc.PageID
      LEFT JOIN Grid g ON g.ID = p.GridID
      LEFT JOIN PDFGrid pdf ON pdf.GridID = p.GridID
      LEFT JOIN PageContent pc ON pc.PageID = p.ID
      LEFT JOIN Element e ON e.ID = pc.ElementID
      LEFT JOIN StrokeElement s ON s.ElementID = e.ID
      LEFT JOIN ImageElement i ON i.ElementID = e.ID
      GROUP BY bc.BookID, bc.PageIndex, p.ID
      ORDER BY bc.BookID, bc.PageIndex
    `);
    const pageCountByBook = new Map();
    for (const page of pages) pageCountByBook.set(page.bookId, (pageCountByBook.get(page.bookId) ?? 0) + 1);
    const booksWithPaths = books.map((book) => ({
      ...book,
      folderPath: book.folderId === null ? null : folderPath(book.folderId),
      pageCount: pageCountByBook.get(book.id) ?? 0
    }));
    return { folders: foldersWithPaths, books: booksWithPaths, pages };
  }

  listFolders() {
    const { folders, books } = this.getLibrary();
    const byId = new Map(folders.map((folder) => [folder.id, { ...folder, folders: [], notebooks: [] }]));
    const root = { folders: [], notebooks: [] };

    for (const folder of byId.values()) {
      const parent = folder.parentFolderId === null ? root : byId.get(folder.parentFolderId);
      (parent ?? root).folders.push(folder);
    }
    for (const book of books) {
      const parent = book.folderId === null ? root : byId.get(book.folderId);
      (parent ?? root).notebooks.push(book);
    }
    return root;
  }

  searchLibrary(query) {
    const term = query.trim().toLocaleLowerCase("de-DE");
    const { folders, books } = this.getLibrary();
    return {
      folders: folders.filter((folder) => folder.name.toLocaleLowerCase("de-DE").includes(term)),
      notebooks: books.filter((book) => book.name.toLocaleLowerCase("de-DE").includes(term)),
      limitation: "Durchsucht nur Ordner- und Notizbuchnamen. In dieser Sicherung gibt es keine gespeicherten Textfelder; Handschrift benötigt OCR."
    };
  }

  getNotebook(notebookId) {
    const notebook = this.get(`
      SELECT b.ID AS id, b.Name AS name, b.TagColor AS tagColor, b.CreationDate AS createdAt,
             b.LastEdited AS updatedAt, relation.FolderID AS folderId
      FROM Book b
      LEFT JOIN FolderBookContent relation ON relation.ChildBookID = b.ID
      WHERE b.ID = ?
    `, notebookId);
    if (!notebook) return undefined;

    const pages = this.all(`
      SELECT bc.PageIndex + 1 AS pageNumber, p.ID AS pageId, p.Width AS width, p.Height AS height,
             p.BackgroundColor AS backgroundColor, p.CreationDate AS createdAt, g.GridType AS gridType,
             pdf.FilePath AS pdfPath,
             COUNT(CASE WHEN e.IsDeleted = 0 THEN 1 END) AS elementCount,
             COUNT(CASE WHEN s.ElementID IS NOT NULL AND e.IsDeleted = 0 THEN 1 END) AS strokeCount,
             COUNT(CASE WHEN i.ElementID IS NOT NULL AND e.IsDeleted = 0 THEN 1 END) AS imageCount
      FROM BookContent bc
      JOIN Page p ON p.ID = bc.PageID
      LEFT JOIN Grid g ON g.ID = p.GridID
      LEFT JOIN PDFGrid pdf ON pdf.GridID = p.GridID
      LEFT JOIN PageContent pc ON pc.PageID = p.ID
      LEFT JOIN Element e ON e.ID = pc.ElementID
      LEFT JOIN StrokeElement s ON s.ElementID = e.ID
      LEFT JOIN ImageElement i ON i.ElementID = e.ID
      WHERE bc.BookID = ?
      GROUP BY bc.PageIndex, p.ID
      ORDER BY bc.PageIndex
    `, notebookId);
    return { ...notebook, pages };
  }

  getPageAssets(pageId) {
    const page = this.get(`
      SELECT p.ID AS pageId, pdf.FilePath AS pdfPath
      FROM Page p
      LEFT JOIN PDFGrid pdf ON pdf.GridID = p.GridID
      WHERE p.ID = ?
    `, pageId);
    if (!page) return undefined;

    const images = this.all(`
      SELECT image.FilePath AS archivePath, image.ImageWidth AS width, image.ImageHeight AS height
      FROM PageContent content
      JOIN Element element ON element.ID = content.ElementID
      JOIN ImageElement image ON image.ElementID = element.ID
      WHERE content.PageID = ? AND element.IsDeleted = 0
      ORDER BY element.CreationDate
    `, pageId);
    const assets = [
      ...(page.pdfPath ? [{ archivePath: page.pdfPath, type: "pdf" }] : []),
      ...images.map((image) => ({ ...image, type: "image" }))
    ].map((asset) => ({ ...asset, existsInBackup: Boolean(this.archive.getEntry(normalizeArchivePath(asset.archivePath))) }));
    return { pageId, assets };
  }

  readArchiveFile(archivePath) {
    this.ensureLoaded();
    const entry = this.archive.getEntry(normalizeArchivePath(archivePath));
    return entry ? entry.getData() : undefined;
  }

  getPageRenderData(pageId) {
    const page = this.get(`
      SELECT p.ID AS pageId, p.Width AS width, p.Height AS height, p.BackgroundColor AS backgroundColor,
             g.GridType AS gridType, pdf.FilePath AS pdfPath, pdf.PageIndex AS pdfPageIndex
      FROM Page p
      LEFT JOIN Grid g ON g.ID = p.GridID
      LEFT JOIN PDFGrid pdf ON pdf.GridID = p.GridID
      WHERE p.ID = ?
    `, pageId);
    if (!page) return undefined;
    const elements = this.all(`
      SELECT e.ID AS id, e.ElementType AS elementType, e.M11 AS m11, e.M12 AS m12, e.M21 AS m21, e.M22 AS m22, e.M31 AS m31, e.M32 AS m32,
             stroke.StrokeWidth AS strokeWidth, stroke.Color AS color, stroke.IsHighlighter AS isHighlighter, stroke.PointsData AS pointsData,
             line.LineType AS lineType, line.X0 AS x0, line.Y0 AS y0, line.X1 AS x1, line.Y1 AS y1, line.StrokeColor AS lineColor, line.StrokeWidth AS lineWidth, line.StrokeDashed AS lineDashed, line.IsHighlighter AS lineIsHighlighter,
             shape.ShapeType AS shapeType, shape.StrokeColor AS shapeStrokeColor, shape.StrokeWidth AS shapeStrokeWidth, shape.StrokeDashed AS shapeDashed, shape.FillColor AS fillColor,
             image.ImageWidth AS imageWidth, image.ImageHeight AS imageHeight, image.FilePath AS imagePath,
             text.Text AS text, text.Width AS textWidth, text.FontFamily AS fontFamily, text.FontSize AS fontSize, text.Color AS textColor
      FROM PageContent content
      JOIN Element e ON e.ID = content.ElementID
      LEFT JOIN StrokeElement stroke ON stroke.ElementID = e.ID
      LEFT JOIN LineElement line ON line.ElementID = e.ID
      LEFT JOIN ShapeElement shape ON shape.ElementID = e.ID
      LEFT JOIN ImageElement image ON image.ElementID = e.ID
      LEFT JOIN TextElement text ON text.ElementID = e.ID
      WHERE content.PageID = ? AND e.IsDeleted = 0
      ORDER BY e.CreationDate, e.ID
    `, pageId);
    return { ...page, elements };
  }

  getBackupSummary(snapshot) {
    const file = statSync(this.backupPath);
    return {
      path: this.backupPath,
      name: basename(this.backupPath),
      size: file.size,
      modifiedAt: new Date(file.mtimeMs).toISOString(),
      folderCount: snapshot.folders.length,
      notebookCount: snapshot.books.length,
      pageCount: snapshot.pages.length,
      archiveEntries: this.archive.getEntries().length
    };
  }

  compareWithPreviousBackup(options = {}) {
    const normalizedOptions = typeof options === "string" ? { baselinePath: options } : options;
    const { baselinePath, includePages = false } = normalizedOptions;
    const currentPath = this.resolveBackupPath();
    const currentSnapshot = this.getSnapshot();
    const currentBackup = this.getBackupSummary(currentSnapshot);
    const currentCanonicalPath = resolve(currentPath).toLocaleLowerCase("en-US");
    let selectedBaselinePath = baselinePath;
    let baselineSelection = "previous_backup";

    if (!selectedBaselinePath) {
      const previous = this.listBackupCandidates()
        .find((candidate) => resolve(candidate.path).toLocaleLowerCase("en-US") !== currentCanonicalPath);
      selectedBaselinePath = previous?.path;
    } else {
      baselineSelection = "explicit_backup";
    }
    if (!selectedBaselinePath) {
      throw new Error("Für einen Vergleich wird mindestens ein älteres .ntcbak-Backup benötigt.");
    }
    if (extname(selectedBaselinePath).toLocaleLowerCase("en-US") !== ".ntcbak") {
      throw new Error("Das Vergleichs-Backup muss eine .ntcbak-Datei sein.");
    }
    if (resolve(selectedBaselinePath).toLocaleLowerCase("en-US") === currentCanonicalPath) {
      throw new Error("Das Vergleichs-Backup entspricht bereits dem aktuellen Backup.");
    }

    const baseline = new NoteasticBackup({ backupPath: selectedBaselinePath, exportDirectory: this.exportDirectory });
    try {
      const baselineSnapshot = baseline.getSnapshot();
      const baselineBackup = baseline.getBackupSummary(baselineSnapshot);
      const detectedAt = currentBackup.modifiedAt;
      const folders = compareRows(currentSnapshot.folders, baselineSnapshot.folders, FOLDER_COMPARE_FIELDS, detectedAt);
      const notebooks = compareRows(currentSnapshot.books, baselineSnapshot.books, BOOK_COMPARE_FIELDS, detectedAt);
      const pages = compareRows(currentSnapshot.pages, baselineSnapshot.pages, PAGE_COMPARE_FIELDS, detectedAt);
      const changes = {
        newFolders: folders.added,
        changedFolders: folders.changed,
        removedFolders: folders.removed,
        newNotebooks: notebooks.added,
        changedNotebooks: notebooks.changed,
        removedNotebooks: notebooks.removed
      };
      const pageSummary = {
        newPages: pages.added.length,
        changedPages: pages.changed.length,
        removedPages: pages.removed.length
      };
      if (includePages) {
        changes.newPages = pages.added;
        changes.changedPages = pages.changed;
        changes.removedPages = pages.removed;
      }
      const summary = {
        ...Object.fromEntries(Object.entries(changes).map(([key, rows]) => [key, rows.length])),
        ...pageSummary
      };
      const totalChanges = Object.values(summary).reduce((total, count) => total + count, 0);
      return {
        baselineSelection,
        currentBackup,
        baselineBackup,
        pagesIncluded: includePages,
        hasChanges: totalChanges > 0,
        summary: { ...summary, totalChanges },
        changes,
        pageChanges: pageSummary,
        limitations: [
          "Ordner besitzen in der Noteastic-Datenbank kein LastEdited-Feld. Bei geänderten Ordnern bezeichnet detectedAt den Zeitpunkt des aktuellen Backups, nicht den exakten Änderungszeitpunkt.",
          "Seitenänderungen werden über Seitenmetadaten und Element-/Strich-/Bildanzahl erkannt; reine Stiländerungen ohne Zählungsänderung können unentdeckt bleiben."
        ]
      };
    } finally {
      baseline.close();
    }
  }

  getBackupInfo() {
    this.ensureLoaded();
    const { folders, books } = this.getLibrary();
    const pageCount = this.get("SELECT COUNT(*) AS count FROM Page").count;
    const file = statSync(this.backupPath);
    return {
      backupPath: this.backupPath,
      backupName: basename(this.backupPath),
      backupSize: file.size,
      backupModifiedAt: new Date(file.mtimeMs).toISOString(),
      backupDirectory: this.backupDirectory,
      folderCount: folders.length,
      notebookCount: books.length,
      pageCount,
      archiveEntries: this.archive.getEntries().length,
      exportDirectory: this.exportDirectory,
      readOnly: true,
      reloadsWhenBackupChanges: true
    };
  }
}
