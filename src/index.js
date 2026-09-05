import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { z } from "zod/v3";
import { NoteasticBackup } from "./backup.js";
import { exportNotebook, exportPage } from "./export.js";

function result(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data
  };
}

function errorResult(error) {
  return {
    content: [{ type: "text", text: error.message }],
    isError: true
  };
}

export function createServer(backupSource) {
  const backup = new NoteasticBackup(backupSource);
  const server = new McpServer({ name: "noteastic-mcp", version: "0.2.0" });
  const run = (handler) => async (arguments_) => {
    try {
      return result(await handler(arguments_));
    } catch (error) {
      return errorResult(error instanceof Error ? error : new Error(String(error)));
    }
  };

  server.registerTool("backup_info", {
    title: "Noteastic-Sicherungsinfo",
    description: "Zeigt Quelle, Umfang, Dateizeitpunkt und Aktualisierungsverhalten der schreibgeschützt geöffneten Noteastic-Sicherung.",
    inputSchema: {}
  }, run(() => backup.getBackupInfo()));

  server.registerTool("changes_since_backup", {
    title: "Änderungen seit dem letzten Backup",
    description: "Vergleicht standardmäßig das neueste .ntcbak-Backup mit dem unmittelbar vorherigen und meldet neue, geänderte und entfernte Ordner und Notizbücher. Seiten werden standardmäßig nur zusammengefasst und können optional vollständig ausgegeben werden. Ein optionaler baselinePath erlaubt den Vergleich mit einem bestimmten älteren Backup.",
    inputSchema: {
      baselinePath: z.string().min(1).max(1000).optional().describe("Optionaler Pfad zu einem älteren .ntcbak-Backup; ohne Angabe wird das vorherige Backup im konfigurierten Ordner verwendet."),
      includePages: z.boolean().default(false).describe("Wenn true, werden neue, geänderte und entfernte Seiten vollständig ausgegeben; standardmäßig nur Seitenzahlen als Zusammenfassung.")
    }
  }, run((arguments_) => backup.compareWithPreviousBackup(arguments_)));

  server.registerTool("list_library", {
    title: "Noteastic-Bibliothek auflisten",
    description: "Liest die vollständige Ordner- und Notizbuchhierarchie aus der Sicherung.",
    inputSchema: {}
  }, run(() => backup.listFolders()));

  server.registerTool("search_library", {
    title: "Noteastic-Bibliothek durchsuchen",
    description: "Durchsucht Ordner- und Notizbuchnamen. Handschriftliche Seiteninhalte sind ohne OCR nicht durchsuchbar.",
    inputSchema: { query: z.string().min(1).max(200).describe("Suchbegriff") }
  }, run(({ query }) => backup.searchLibrary(query)));

  server.registerTool("get_notebook", {
    title: "Noteastic-Notizbuch lesen",
    description: "Liefert Metadaten und eine Seitenübersicht eines Notizbuchs, einschließlich PDF-Hintergründen und handschriftlicher Elemente.",
    inputSchema: { notebookId: z.number().int().positive().describe("ID aus list_library oder search_library") }
  }, run(({ notebookId }) => {
    const notebook = backup.getNotebook(notebookId);
    if (!notebook) throw new Error(`Kein Notizbuch mit der ID ${notebookId} gefunden.`);
    return notebook;
  }));

  server.registerTool("get_page_assets", {
    title: "Seitendateien auflisten",
    description: "Listet zu einer Seite gehörende PDF- und Bilddateien innerhalb der Sicherung auf. Die Dateien werden nicht verändert.",
    inputSchema: { pageId: z.number().int().positive().describe("Seiten-ID aus get_notebook") }
  }, run(({ pageId }) => {
    const page = backup.getPageAssets(pageId);
    if (!page) throw new Error(`Keine Seite mit der ID ${pageId} gefunden.`);
    return page;
  }));

  server.registerTool("export_page", {
    title: "Noteastic-Seite exportieren",
    description: "Exportiert eine Noteastic-Seite lokal als PNG, PDF oder beides. Die Sicherung bleibt unverändert; neue Dateien werden ausschließlich im konfigurierten Export-Ordner angelegt.",
    inputSchema: {
      pageId: z.number().int().positive().describe("Seiten-ID aus get_notebook"),
      format: z.enum(["png", "pdf", "both"]).default("both").describe("Gewünschtes Exportformat"),
      scale: z.number().min(1).max(3).default(2).describe("Auflösung: 1 bis 3, Standard 2")
    }
  }, run((arguments_) => exportPage(backup, arguments_)));

  server.registerTool("export_notebook", {
    title: "Noteastic-Notizbuch exportieren",
    description: "Exportiert alle Seiten eines Noteastic-Notizbuchs als mehrseitiges PDF, einzelne PNG-Dateien oder beides. Die Sicherung bleibt unverändert.",
    inputSchema: {
      notebookId: z.number().int().positive().describe("Notizbuch-ID aus list_library oder search_library"),
      format: z.enum(["png", "pdf", "both"]).default("pdf").describe("Gewünschtes Exportformat"),
      scale: z.number().min(1).max(3).default(2).describe("Auflösung: 1 bis 3, Standard 2")
    }
  }, run((arguments_) => exportNotebook(backup, arguments_)));

  return { server, backup };
}

async function main() {
  const backupPath = process.env.NOTEASTIC_BACKUP_PATH;
  const backupDirectory = process.env.NOTEASTIC_BACKUP_DIR;
  const exportDirectory = process.env.NOTEASTIC_EXPORT_DIR;
  if (!backupPath && !backupDirectory) {
    throw new Error("NOTEASTIC_BACKUP_PATH oder NOTEASTIC_BACKUP_DIR fehlt.");
  }
  const { server } = createServer({ backupPath, backupDirectory, exportDirectory });
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`noteastic-mcp: ${error.message}`);
    process.exit(1);
  });
}
