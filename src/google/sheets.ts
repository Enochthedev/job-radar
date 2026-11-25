import type { Account } from "../db/schema.js";
import { googleFetch } from "./oauth.js";

const BASE = "https://sheets.googleapis.com/v4/spreadsheets";

export async function createSpreadsheet(account: Account, title: string): Promise<string> {
  const r = await googleFetch<{ spreadsheetId: string }>(account, BASE, { method: "POST", body: JSON.stringify({ properties: { title } }) });
  return r.spreadsheetId;
}

export const sheetUrl = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`;

export async function ensureTab(account: Account, sheetId: string, title: string, header: string[]): Promise<void> {
  const meta = await googleFetch<{ sheets: { properties: { title: string; sheetId: number } }[] }>(account, `${BASE}/${sheetId}?fields=sheets.properties`);
  const existing = meta.sheets.find((s) => s.properties.title === title);
  if (existing) return;
  const res = await googleFetch<{ replies: { addSheet: { properties: { sheetId: number } } }[] }>(account, `${BASE}/${sheetId}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } }] }),
  });
  const tabId = res.replies[0].addSheet.properties.sheetId;
  await writeRange(account, sheetId, `${title}!A1`, [header]);
  const decisionCol = header.indexOf("Decision");
  if (decisionCol >= 0) {
    await googleFetch(account, `${BASE}/${sheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ requests: [
        { setDataValidation: {
          range: { sheetId: tabId, startRowIndex: 1, startColumnIndex: decisionCol, endColumnIndex: decisionCol + 1 },
          rule: { condition: { type: "ONE_OF_LIST", values: [{ userEnteredValue: "Apply" }, { userEnteredValue: "Skip" }] }, showCustomUi: true, strict: false },
        } },
        { repeatCell: { range: { sheetId: tabId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } },
      ] }),
    });
  }
}

export async function readRange(account: Account, sheetId: string, range: string): Promise<string[][]> {
  const r = await googleFetch<{ values?: string[][] }>(account, `${BASE}/${sheetId}/values/${encodeURIComponent(range)}`);
  return r.values ?? [];
}

export async function writeRange(account: Account, sheetId: string, range: string, values: (string | number | null)[][]): Promise<void> {
  await googleFetch(account, `${BASE}/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ range, majorDimension: "ROWS", values }),
  });
}

export async function appendRows(account: Account, sheetId: string, range: string, values: (string | number | null)[][]): Promise<void> {
  await googleFetch(account, `${BASE}/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: "POST",
    body: JSON.stringify({ majorDimension: "ROWS", values }),
  });
}
