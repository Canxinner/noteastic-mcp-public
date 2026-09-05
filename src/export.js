import { createCanvas, DOMMatrix, ImageData, Path2D, loadImage } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

globalThis.DOMMatrix ??= DOMMatrix;
globalThis.ImageData ??= ImageData;
globalThis.Path2D ??= Path2D;

const DEFAULT_SCALE = 2;
const MAX_SCALE = 3;
let pdfjsPromise;

function getPdfJs() {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

function parseColor(value, fallback = "#000000") {
  const color = typeof value === "string" ? value.trim() : "";
  const match = /^#([0-9a-f]{8})$/i.exec(color);
  if (match) {
    const hex = match[1];
    return { css: `#${hex.slice(2)}`, alpha: Number.parseInt(hex.slice(0, 2), 16) / 255 };
  }
  if (/^#[0-9a-f]{6}$/i.test(color)) return { css: color, alpha: 1 };
  return { css: fallback, alpha: 1 };
}

function parsePoints(pointsData) {
  if (typeof pointsData !== "string") return [];
  return pointsData.split(";").slice(1).map((point) => {
    const [x, y, pressure] = point.split(",").map(Number);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y, pressure } : undefined;
  }).filter(Boolean);
}

function applyElementTransform(context, element) {
  context.transform(
    Number.isFinite(element.m11) ? element.m11 : 1,
    Number.isFinite(element.m12) ? element.m12 : 0,
    Number.isFinite(element.m21) ? element.m21 : 0,
    Number.isFinite(element.m22) ? element.m22 : 1,
    Number.isFinite(element.m31) ? element.m31 : 0,
    Number.isFinite(element.m32) ? element.m32 : 0
  );
}

function drawGrid(context, page) {
  const type = String(page.gridType ?? "").toLocaleLowerCase("en-US");
  if (!type.includes("line") && !type.includes("check") && !type.includes("bullet")) return;
  context.save();
  context.strokeStyle = "#d8deea";
  context.fillStyle = "#d8deea";
  context.globalAlpha = 0.65;
  context.lineWidth = 0.7;
  const spacing = 28;
  if (type.includes("line") || type.includes("check")) {
    for (let y = spacing; y < page.height; y += spacing) {
      context.beginPath(); context.moveTo(0, y); context.lineTo(page.width, y); context.stroke();
    }
  }
  if (type.includes("check")) {
    for (let x = spacing; x < page.width; x += spacing) {
      context.beginPath(); context.moveTo(x, 0); context.lineTo(x, page.height); context.stroke();
    }
  }
  if (type.includes("bullet")) {
    for (let y = spacing; y < page.height; y += spacing) for (let x = spacing; x < page.width; x += spacing) {
      context.beginPath(); context.arc(x, y, 0.9, 0, Math.PI * 2); context.fill();
    }
  }
  context.restore();
}

async function drawPdfBackground(context, width, height, pdfData, pageIndex) {
  const pdfjs = await getPdfJs();
  const document = await pdfjs.getDocument({ data: new Uint8Array(pdfData), disableWorker: true }).promise;
  try {
    const page = await document.getPage(Math.max(1, (pageIndex ?? 0) + 1));
    const naturalViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(width / naturalViewport.width, height / naturalViewport.height);
    const viewport = page.getViewport({ scale });
    const background = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvasContext: background.getContext("2d"), viewport }).promise;
    context.drawImage(background, (width - background.width) / 2, (height - background.height) / 2);
  } finally {
    await document.destroy();
  }
}

function drawStroke(context, element) {
  const points = parsePoints(element.pointsData);
  if (!points.length) return;
  const color = parseColor(element.color);
  context.save();
  applyElementTransform(context, element);
  context.strokeStyle = color.css;
  context.globalAlpha = color.alpha * (element.isHighlighter ? 0.38 : 1);
  context.lineWidth = Math.max(0.5, Number(element.strokeWidth) || 1.7);
  context.lineCap = "round";
  context.lineJoin = "round";
  if (points.length === 1) {
    context.fillStyle = color.css;
    context.beginPath(); context.arc(points[0].x, points[0].y, context.lineWidth / 2, 0, Math.PI * 2); context.fill();
  } else {
    context.beginPath(); context.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) context.lineTo(point.x, point.y);
    context.stroke();
  }
  context.restore();
}

function drawLine(context, element) {
  const color = parseColor(element.lineColor);
  context.save();
  applyElementTransform(context, element);
  context.strokeStyle = color.css;
  context.globalAlpha = color.alpha * (element.isHighlighter ? 0.38 : 1);
  context.lineWidth = Math.max(0.5, Number(element.lineWidth) || 1);
  context.lineCap = "round";
  if (element.lineDashed) context.setLineDash([context.lineWidth * 4, context.lineWidth * 3]);
  context.beginPath(); context.moveTo(element.x0, element.y0); context.lineTo(element.x1, element.y1); context.stroke();
  const angle = Math.atan2(element.y1 - element.y0, element.x1 - element.x0);
  const arrowSize = Math.max(7, context.lineWidth * 5);
  const arrow = (x, y, direction) => {
    context.beginPath(); context.moveTo(x, y);
    context.lineTo(x - Math.cos(direction - 0.45) * arrowSize, y - Math.sin(direction - 0.45) * arrowSize);
    context.lineTo(x - Math.cos(direction + 0.45) * arrowSize, y - Math.sin(direction + 0.45) * arrowSize);
    context.closePath(); context.fill();
  };
  context.fillStyle = color.css;
  if (element.lineType === "SingleArrow" || element.lineType === "DoubleArrow") arrow(element.x1, element.y1, angle);
  if (element.lineType === "DoubleArrow") arrow(element.x0, element.y0, angle + Math.PI);
  context.restore();
}

function drawShape(context, element) {
  const stroke = parseColor(element.shapeStrokeColor);
  const fill = parseColor(element.fillColor, "transparent");
  const x = Math.min(element.x0, element.x1), y = Math.min(element.y0, element.y1);
  const width = Math.abs(element.x1 - element.x0), height = Math.abs(element.y1 - element.y0);
  context.save();
  applyElementTransform(context, element);
  context.strokeStyle = stroke.css;
  context.fillStyle = fill.css;
  context.globalAlpha = stroke.alpha;
  context.lineWidth = Math.max(0.5, Number(element.shapeStrokeWidth) || 1);
  if (element.shapeDashed) context.setLineDash([context.lineWidth * 4, context.lineWidth * 3]);
  context.beginPath();
  if (element.shapeType === "Ellipse") context.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
  else if (element.shapeType === "Triangle") { context.moveTo(x + width / 2, y); context.lineTo(x + width, y + height); context.lineTo(x, y + height); context.closePath(); }
  else context.rect(x, y, width, height);
  if (fill.alpha > 0 && fill.css !== "transparent") { context.save(); context.globalAlpha = fill.alpha; context.fill(); context.restore(); }
  context.stroke();
  if (element.shapeType === "OneQuadrant" || element.shapeType === "FourQuadrant") {
    const cx = x + width / 2, cy = y + height / 2;
    context.beginPath(); context.moveTo(cx, y); context.lineTo(cx, y + height);
    if (element.shapeType === "FourQuadrant") { context.moveTo(x, cy); context.lineTo(x + width, cy); }
    context.stroke();
  }
  context.restore();
}

async function drawImage(context, element, readArchiveFile, warnings) {
  if (!element.imagePath) return;
  const data = readArchiveFile(element.imagePath);
  if (!data) { warnings.push(`Bild ${element.imagePath} fehlt in der Sicherung.`); return; }
  try {
    const image = await loadImage(data);
    context.save(); applyElementTransform(context, element);
    context.drawImage(image, 0, 0, element.imageWidth || image.width, element.imageHeight || image.height);
    context.restore();
  } catch (error) { warnings.push(`Bild ${element.imagePath} konnte nicht gezeichnet werden: ${error.message}`); }
}

function drawText(context, element) {
  if (!element.text) return;
  const color = parseColor(element.textColor);
  context.save(); applyElementTransform(context, element);
  context.fillStyle = color.css; context.globalAlpha = color.alpha;
  context.font = `${Math.max(1, Number(element.fontSize) || 16)}px ${element.fontFamily || "Arial"}`;
  context.textBaseline = "top"; context.fillText(element.text, 0, 0, element.textWidth || undefined); context.restore();
}

export async function renderPage(backup, pageId, scale = DEFAULT_SCALE) {
  const page = backup.getPageRenderData(pageId);
  if (!page) throw new Error(`Keine Seite mit der ID ${pageId} gefunden.`);
  const renderScale = Math.min(MAX_SCALE, Math.max(1, scale ?? DEFAULT_SCALE));
  const width = Math.ceil(page.width * renderScale), height = Math.ceil(page.height * renderScale);
  const canvas = createCanvas(width, height), context = canvas.getContext("2d");
  const background = parseColor(page.backgroundColor, "#ffffff");
  context.fillStyle = background.css; context.globalAlpha = background.alpha; context.fillRect(0, 0, width, height);
  const warnings = [];
  if (page.pdfPath) {
    const pdfData = backup.readArchiveFile(page.pdfPath);
    if (pdfData) {
      try { await drawPdfBackground(context, width, height, pdfData, page.pdfPageIndex); }
      catch (error) { warnings.push(`PDF-Hintergrund ${page.pdfPath} konnte nicht gezeichnet werden: ${error.message}`); }
    } else warnings.push(`PDF-Hintergrund ${page.pdfPath} fehlt in der Sicherung.`);
  } else { context.save(); context.scale(renderScale, renderScale); drawGrid(context, page); context.restore(); }
  context.save(); context.scale(renderScale, renderScale);
  for (const element of page.elements) {
    if (element.elementType === "InkStroke" || element.elementType === "Highlighter") drawStroke(context, element);
    else if (element.elementType === "Line" || element.elementType === "LineHighlighter") drawLine(context, element);
    else if (element.elementType === "Shape") drawShape(context, element);
    else if (element.elementType === "Image") await drawImage(context, element, backup.readArchiveFile.bind(backup), warnings);
    else if (element.elementType === "Text") drawText(context, element);
  }
  context.restore();
  return { page, png: canvas.toBuffer("image/png"), warnings, width, height, scale: renderScale };
}

function safeName(value) { return String(value ?? "noteastic").replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "noteastic"; }
function uniquePath(directory, name, extension) { let n = 1, path = join(directory, `${name}.${extension}`); while (existsSync(path)) path = join(directory, `${name}-${++n}.${extension}`); return path; }
function getExportDirectory(backup) { mkdirSync(backup.exportDirectory, { recursive: true }); return backup.exportDirectory; }

export async function exportPage(backup, { pageId, format = "both", scale = DEFAULT_SCALE }) {
  const rendered = await renderPage(backup, pageId, scale), directory = getExportDirectory(backup), files = [];
  if (format === "png" || format === "both") { const path = uniquePath(directory, `noteastic-page-${pageId}`, "png"); writeFileSync(path, rendered.png); files.push(path); }
  if (format === "pdf" || format === "both") {
    const document = await PDFDocument.create(), image = await document.embedPng(rendered.png);
    const page = document.addPage([rendered.width / rendered.scale, rendered.height / rendered.scale]);
    page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
    const path = uniquePath(directory, `noteastic-page-${pageId}`, "pdf"); writeFileSync(path, await document.save()); files.push(path);
  }
  return { pageId, format, scale: rendered.scale, files, warnings: rendered.warnings };
}

export async function exportNotebook(backup, { notebookId, format = "pdf", scale = DEFAULT_SCALE }) {
  const notebook = backup.getNotebook(notebookId);
  if (!notebook) throw new Error(`Kein Notizbuch mit der ID ${notebookId} gefunden.`);
  const directory = getExportDirectory(backup), baseName = `noteastic-${safeName(notebook.name)}-${notebookId}`;
  const renderedPages = [];
  for (const page of notebook.pages) renderedPages.push(await renderPage(backup, page.pageId, scale));
  const files = [], warnings = renderedPages.flatMap((rendered) => rendered.warnings.map((warning) => `Seite ${rendered.page.pageId}: ${warning}`));
  if (format === "png" || format === "both") for (const [index, rendered] of renderedPages.entries()) {
    const path = uniquePath(directory, `${baseName}-seite-${String(index + 1).padStart(3, "0")}`, "png"); writeFileSync(path, rendered.png); files.push(path);
  }
  if (format === "pdf" || format === "both") {
    const document = await PDFDocument.create();
    for (const rendered of renderedPages) {
      const image = await document.embedPng(rendered.png), page = document.addPage([rendered.width / rendered.scale, rendered.height / rendered.scale]);
      page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
    }
    const path = uniquePath(directory, baseName, "pdf"); writeFileSync(path, await document.save()); files.push(path);
  }
  return { notebookId, notebookName: notebook.name, pageCount: renderedPages.length, format, scale: renderedPages[0]?.scale ?? scale, files, warnings };
}
