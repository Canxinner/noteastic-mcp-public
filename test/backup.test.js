import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import AdmZip from "adm-zip";
import { DatabaseSync } from "node:sqlite";
import { PDFDocument } from "pdf-lib";
import { NoteasticBackup } from "../src/backup.js";
import { exportNotebook, exportPage } from "../src/export.js";

async function createFixture({ useWindowsAssetPaths = false, bookEdited = "2026-01-02", addNotebook = false, addFolder = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "noteastic-mcp-"));
  const database = new DatabaseSync(":memory:");
  const pdfPath = useWindowsAssetPaths ? "PDFs\\analysis.pdf" : "PDFs/analysis.pdf";
  database.exec(`
    CREATE TABLE Folder (ID INTEGER PRIMARY KEY, Name TEXT, Color TEXT, CreationDate TEXT);
    CREATE TABLE FolderFolderContent (FolderID INTEGER, ChildFolderID INTEGER);
    CREATE TABLE Book (ID INTEGER PRIMARY KEY, Name TEXT, TagColor TEXT, CreationDate TEXT, LastEdited TEXT);
    CREATE TABLE FolderBookContent (FolderID INTEGER, ChildBookID INTEGER);
    CREATE TABLE Page (ID INTEGER PRIMARY KEY, GridID INTEGER, Width REAL, Height REAL, BackgroundColor TEXT, CreationDate TEXT);
    CREATE TABLE BookContent (BookID INTEGER, PageIndex INTEGER, PageID INTEGER);
    CREATE TABLE Grid (ID INTEGER PRIMARY KEY, GridType TEXT, IsDeleted BOOL);
    CREATE TABLE PDFGrid (GridID INTEGER, FilePath TEXT, PageIndex INTEGER, Password TEXT);
    CREATE TABLE PageContent (PageID INTEGER, ElementID INTEGER);
    CREATE TABLE Element (ID INTEGER PRIMARY KEY, ElementType TEXT, CreationDate TEXT, M11 REAL, M12 REAL, M21 REAL, M22 REAL, M31 REAL, M32 REAL, IsDeleted BOOL);
    CREATE TABLE StrokeElement (ElementID INTEGER, StrokeWidth REAL, StrokeHeight REAL, Color TEXT, IsHighlighter BOOL, IgnorePressure BOOL, PointsData TEXT);
    CREATE TABLE LineElement (ElementID INTEGER, LineType TEXT, X0 REAL, Y0 REAL, X1 REAL, Y1 REAL, StrokeColor TEXT, StrokeWidth REAL, StrokeDashed BOOL, IsHighlighter BOOL);
    CREATE TABLE ShapeElement (ElementID INTEGER, ShapeType TEXT, X0 REAL, Y0 REAL, X1 REAL, Y1 REAL, StrokeColor TEXT, StrokeWidth REAL, StrokeDashed BOOL, FillColor TEXT);
    CREATE TABLE ImageElement (ElementID INTEGER, ImageWidth INTEGER, ImageHeight INTEGER, FilePath TEXT);
    CREATE TABLE TextElement (ElementID INTEGER, Text TEXT, Width REAL, FontFamily TEXT, FontSize REAL, Color TEXT, HorizontalTextAlignment TEXT, Spans TEXT);
    INSERT INTO Folder VALUES (1, 'Mathe', '#000000', '2026-01-01');
    INSERT INTO Book VALUES (10, 'Analysis', '#FF0000', '2026-01-01', '${bookEdited}');
    INSERT INTO FolderBookContent VALUES (1, 10);
    INSERT INTO Grid VALUES (100, 'PDF', 0);
    INSERT INTO PDFGrid VALUES (100, '${pdfPath}', 0, NULL);
    INSERT INTO Page VALUES (1000, 100, 100, 200, '#FFFFFF', '2026-01-01');
    INSERT INTO BookContent VALUES (10, 0, 1000);
    INSERT INTO Element VALUES (5000, 'InkStroke', '2026-01-01', 1, 0, 0, 1, 0, 0, 0);
    INSERT INTO StrokeElement VALUES (5000, 1, 1, '#FF000000', 0, 0, '2;20,20,0.5;80,160,0.5');
    INSERT INTO PageContent VALUES (1000, 5000);
  `);
  if (addFolder) database.exec("INSERT INTO Folder VALUES (2, 'Neu', '#00FF00', '2026-01-03');");
  if (addNotebook) database.exec("INSERT INTO Book VALUES (11, 'Neues Kapitel', '#0000FF', '2026-01-03', '2026-01-03'); INSERT INTO FolderBookContent VALUES (2, 11);");
  const background = await PDFDocument.create();
  background.addPage([100, 200]);
  const archive = new AdmZip();
  archive.addFile("noteastic.db", database.serialize());
  archive.addFile("PDFs/analysis.pdf", Buffer.from(await background.save()));
  const path = join(directory, "fixture.ntcbak");
  archive.writeZip(path);
  database.close();
  return { directory, path };
}

test("reads the library, renders pages, and exports PNG/PDF files from a Noteastic backup", async () => {
  const useWindowsAssetPaths = true;
  const fixture = await createFixture({ useWindowsAssetPaths });
  try {
    const exportDirectory = join(fixture.directory, "exports");
    const backup = new NoteasticBackup({ backupDirectory: fixture.directory, exportDirectory });
    const library = backup.listFolders();
    assert.equal(library.folders[0].name, "Mathe");
    assert.equal(library.folders[0].notebooks[0].name, "Analysis");

    const notebook = backup.getNotebook(10);
    assert.equal(notebook.pages[0].pageId, 1000);
    assert.equal(notebook.pages[0].strokeCount, 1);
    assert.equal(notebook.pages[0].pdfPath, useWindowsAssetPaths ? "PDFs\\analysis.pdf" : "PDFs/analysis.pdf");

    assert.deepEqual(backup.getPageAssets(1000).assets, [{ archivePath: useWindowsAssetPaths ? "PDFs\\analysis.pdf" : "PDFs/analysis.pdf", type: "pdf", existsInBackup: true }]);
    assert.equal(backup.searchLibrary("anal").notebooks.length, 1);

    const pageExport = await exportPage(backup, { pageId: 1000, format: "both", scale: 1 });
    assert.equal(pageExport.files.length, 2);
    assert.ok(pageExport.files.every(existsSync));
    assert.ok(pageExport.files.every((file) => statSync(file).size > 100));
    const pdfFile = pageExport.files.find((file) => file.endsWith(".pdf"));
    assert.equal((await PDFDocument.load(readFileSync(pdfFile))).getPageCount(), 1);

    const notebookExport = await exportNotebook(backup, { notebookId: 10, format: "pdf", scale: 1 });
    assert.equal(notebookExport.pageCount, 1);
    assert.equal(notebookExport.files.length, 1);
    assert.equal((await PDFDocument.load(readFileSync(notebookExport.files[0]))).getPageCount(), 1);
    backup.close();
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("compares a current backup with an older backup", async () => {
  const older = await createFixture({ useWindowsAssetPaths: true, bookEdited: "2026-01-02" });
  const newer = await createFixture({ useWindowsAssetPaths: true, bookEdited: "2026-01-03", addNotebook: true, addFolder: true });
  try {
    const backup = new NoteasticBackup({ backupPath: newer.path, exportDirectory: join(newer.directory, "exports") });
    const report = backup.compareWithPreviousBackup(older.path);
    assert.equal(report.hasChanges, true);
    assert.equal(report.summary.newFolders, 1);
    assert.equal(report.summary.newNotebooks, 1);
    assert.equal(report.summary.changedNotebooks, 1);
    assert.equal(report.changes.newNotebooks[0].folderPath, "Neu");
    assert.deepEqual(report.changes.changedNotebooks[0].changedFields, ["updatedAt"]);
    backup.close();
  } finally {
    rmSync(older.directory, { recursive: true, force: true });
    rmSync(newer.directory, { recursive: true, force: true });
  }
});
