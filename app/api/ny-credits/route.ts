import { NextRequest, NextResponse } from "next/server";
import { fetchSocrataMetadata, socrataQuery } from "@/lib/socrataV3";

type SocrataColumn = {
  fieldName?: string;
  name?: string;
};

type SocrataResponse = {
  data: any[];
  meta: {
    view?: {
      columns?: SocrataColumn[];
    };
    fetchedColumns?: SocrataColumn[];
  };
};

type SocrataViewMetadata = {
  columns?: SocrataColumn[];
};

type ColumnMap = {
  year: string;
  claimed?: string;
  used?: string;
  program?: string;
  taxpayerType?: string;
};

let cachedColumnMap: ColumnMap | null = null;

const YEAR_PATTERNS = [
  /(calendar|tax|fiscal).*year/i,
  /(reporting|taxable).*year/i,
  /^year$/i,
  /year/i,
];
const CLAIMED_PATTERNS = [
  /(claimed|amount|value|approved)/i,
  /(total|sum).*claimed/i,
];
const USED_PATTERNS = [
  /(used|utilized|applied)/i,
  /(amount|value).*used/i,
];
const PROGRAM_PATTERNS = [
  /(program|credit.*name|credit.*type|description)/i,
  /(program|credit).*title/i,
];
const TAXPAYER_PATTERNS = [
  /(taxpayer|entity).*type/i,
  /(applicant|organization).*type/i,
];

function findColumnFromList(
  candidates: (SocrataColumn | string)[],
  patterns: RegExp[],
): string | undefined {
  for (const pattern of patterns) {
    for (const candidate of candidates) {
      if (typeof candidate === "string") {
        if (pattern.test(candidate)) {
          return candidate;
        }
        continue;
      }

      const fieldName = candidate.fieldName ?? "";
      const name = candidate.name ?? "";
      if (pattern.test(fieldName)) {
        return fieldName;
      }
      if (pattern.test(name)) {
        return candidate.fieldName ?? name;
      }
    }
  }
  return undefined;
}

async function getColumnMap(): Promise<ColumnMap> {
  if (cachedColumnMap) {
    return cachedColumnMap;
  }

  let columns: SocrataColumn[] = [];
  try {
    const metadata = await fetchSocrataMetadata<SocrataViewMetadata>();
    columns = metadata.columns ?? [];
  } catch (error) {
    console.warn("Unable to load Socrata metadata", error);
  }

  const columnMap: ColumnMap = {
    year: findColumnFromList(columns, YEAR_PATTERNS) ?? "",
    claimed: findColumnFromList(columns, CLAIMED_PATTERNS),
    used: findColumnFromList(columns, USED_PATTERNS),
    program: findColumnFromList(columns, PROGRAM_PATTERNS),
    taxpayerType: findColumnFromList(columns, TAXPAYER_PATTERNS),
  };

  const needsFallback = !columnMap.year || !columnMap.claimed || !columnMap.used || !columnMap.program;

  if (needsFallback) {
    try {
      const sampleResponse = await socrataQuery<SocrataResponse | Record<string, any>[]>(
        "SELECT * LIMIT 1",
      );
      const sampleRows = mapRows(sampleResponse);
      const sampleColumns = sampleRows.length > 0 ? Object.keys(sampleRows[0]) : [];

      const fallbackMap: ColumnMap = {
        year: columnMap.year || findColumnFromList(sampleColumns, YEAR_PATTERNS) || "",
        claimed: columnMap.claimed || findColumnFromList(sampleColumns, CLAIMED_PATTERNS),
        used: columnMap.used || findColumnFromList(sampleColumns, USED_PATTERNS),
        program: columnMap.program || findColumnFromList(sampleColumns, PROGRAM_PATTERNS),
        taxpayerType:
          columnMap.taxpayerType || findColumnFromList(sampleColumns, TAXPAYER_PATTERNS),
      };

      Object.assign(columnMap, fallbackMap);
    } catch (error) {
      console.warn("Unable to infer columns from sample Socrata row", error);
    }
  }

  if (!columnMap.year) {
    throw new Error("Unable to identify year column in Socrata dataset");
  }

  cachedColumnMap = columnMap;
  return columnMap;
}

function sanitizeValue(value: string): string {
  return value.replace(/'/g, "''");
}

function normalizeColumnKey(column: SocrataColumn, index: number): string {
  const rawKey = column.fieldName || column.name || `col_${index}`;
  return rawKey.replace(/"/g, "");
}

function mapRows(response: SocrataResponse | Record<string, any>[]): Record<string, any>[] {
  if (Array.isArray(response)) {
    return response.map((row) => ({ ...row }));
  }
  const columns = response.meta?.fetchedColumns ?? response.meta?.view?.columns ?? [];
  const rows = response.data ?? [];

  return rows.map((row: any) => {
    if (row && typeof row === "object" && !Array.isArray(row)) {
      return row;
    }

    const record: Record<string, any> = {};
    columns.forEach((column, index) => {
      const key = normalizeColumnKey(column, index);
      if (Array.isArray(row)) {
        record[key] = row[index];
      }
    });
    return record;
  });
}

type ParsedParams = {
  yearFrom?: number;
  yearTo?: number;
  program?: string[];
  taxpayerType?: string;
  view: "raw" | "agg";
  format: "json" | "csv";
};

function parseSearchParams(req: NextRequest): ParsedParams {
  const { searchParams } = new URL(req.url);
  const yearFrom = searchParams.get("year_from");
  const yearTo = searchParams.get("year_to");
  const programParam = searchParams.get("program");
  const taxpayerTypeParam = searchParams.get("taxpayer_type");
  const view = (searchParams.get("view") as "raw" | "agg") || "agg";
  const format = (searchParams.get("format") as "json" | "csv") || "json";

  return {
    yearFrom: yearFrom ? Number.parseInt(yearFrom, 10) : undefined,
    yearTo: yearTo ? Number.parseInt(yearTo, 10) : undefined,
    program: programParam
      ? programParam
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : undefined,
    taxpayerType: taxpayerTypeParam ? taxpayerTypeParam.trim() : undefined,
    view,
    format,
  };
}

function buildWhereClauses(params: ParsedParams, columns: ColumnMap): string[] {
  const clauses: string[] = [];
  if (params.yearFrom !== undefined) {
    clauses.push(`"${columns.year}" >= ${params.yearFrom}`);
  }
  if (params.yearTo !== undefined) {
    clauses.push(`"${columns.year}" <= ${params.yearTo}`);
  }
  if (params.program && params.program.length > 0 && columns.program) {
    const values = params.program.map((value) => `'${sanitizeValue(value)}'`).join(", ");
    clauses.push(`"${columns.program}" IN (${values})`);
  }
  if (params.taxpayerType && columns.taxpayerType) {
    clauses.push(`"${columns.taxpayerType}" = '${sanitizeValue(params.taxpayerType)}'`);
  }
  return clauses;
}

function buildWhere(params: ParsedParams, columns: ColumnMap): string {
  const clauses = buildWhereClauses(params, columns);
  return clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
}

function toNumber(value: any): number {
  if (value === null || value === undefined) return 0;
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function computeUtilization(claimed: number, used: number): number {
  if (!claimed) return 0;
  return (used / claimed) * 100;
}

function buildRawSelect(columns: ColumnMap): string {
  const claimedExpr = columns.claimed ? `"${columns.claimed}"` : "0";
  const usedExpr = columns.used ? `"${columns.used}"` : "0";
  const programExpr = columns.program ? `"${columns.program}"` : "NULL";
  const taxpayerExpr = columns.taxpayerType ? `"${columns.taxpayerType}"` : "NULL";

  return `SELECT "${columns.year}" AS year, ${programExpr} AS program, ${claimedExpr} AS claimed, ${usedExpr} AS used, ${taxpayerExpr} AS taxpayer_type`;
}

type NormalizedRow = {
  year: number | string;
  program: string;
  claimed: number;
  used: number;
  taxpayer_type?: string;
  utilizationPct: number;
};

function normalizeRow(row: Record<string, any>, columns: ColumnMap): NormalizedRow {
  const yearValue = row.year ?? row[columns.year];
  const programValue = row.program ?? (columns.program ? row[columns.program] : undefined);
  const claimedValue = row.claimed ?? (columns.claimed ? row[columns.claimed] : undefined);
  const usedValue = row.used ?? (columns.used ? row[columns.used] : undefined);
  const taxpayerValue =
    row.taxpayer_type ?? (columns.taxpayerType ? row[columns.taxpayerType] : undefined);

  const claimed = toNumber(claimedValue);
  const used = toNumber(usedValue);
  const yearNumber = typeof yearValue === "number" ? yearValue : Number.parseInt(String(yearValue), 10);

  return {
    year: Number.isFinite(yearNumber) ? yearNumber : yearValue ?? "Unknown",
    program: programValue ? String(programValue) : "Unknown",
    claimed,
    used,
    taxpayer_type: taxpayerValue ? String(taxpayerValue) : undefined,
    utilizationPct: computeUtilization(claimed, used),
  };
}

function buildYearRange(years: number[]): number[] {
  if (!years.length) {
    return [];
  }

  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);
  const range: number[] = [];

  for (let year = minYear; year <= maxYear; year += 1) {
    range.push(year);
  }

  return range;
}

function rowsToCsv(rows: NormalizedRow[]): string {
  const csvLines = ["year,program,claimed,used,taxpayer_type"];

  for (const row of rows) {
    const values = [row.year, row.program, row.claimed, row.used, row.taxpayer_type]
      .map((value) => {
        if (value === null || value === undefined) return "";
        const stringValue = String(value);
        if (stringValue.includes(",") || stringValue.includes("\"")) {
          return `"${stringValue.replace(/"/g, '""')}"`;
        }
        return stringValue;
      })
      .join(",");
    csvLines.push(values);
  }

  return csvLines.join("\n");
}

export async function GET(req: NextRequest) {
  try {
    const params = parseSearchParams(req);
    const columns = await getColumnMap();

    const whereClause = buildWhere(params, columns);

    const rawSelect = buildRawSelect(columns);
    const rawQuery = `${rawSelect} ${whereClause} ORDER BY "${columns.year}" DESC LIMIT 50000`;
    const rawResponse = await socrataQuery<SocrataResponse | Record<string, any>[]>(rawQuery);
    const mappedRows = mapRows(rawResponse).map((row) => normalizeRow(row, columns));

    if (params.format === "csv") {
      const csvContent = rowsToCsv(mappedRows);
      return new Response(csvContent, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": "attachment; filename=ny-credits.csv",
        },
      });
    }

    const yearlyMap = new Map<number, { claimed: number; used: number }>();
    const programClaimedTotals = new Map<string, number>();
    const programOptionsSet = new Set<string>();
    const taxpayerOptionsSet = new Set<string>();

    for (const row of mappedRows) {
      const yearNumber = typeof row.year === "number" ? row.year : Number.parseInt(String(row.year), 10);
      if (Number.isFinite(yearNumber)) {
        const current = yearlyMap.get(yearNumber) ?? { claimed: 0, used: 0 };
        current.claimed += row.claimed;
        current.used += row.used;
        yearlyMap.set(yearNumber, current);
      }

      if (row.program && row.program !== "Unknown") {
        programOptionsSet.add(row.program);
      }
      const existingProgramTotal = programClaimedTotals.get(row.program) ?? 0;
      programClaimedTotals.set(row.program, existingProgramTotal + row.claimed);

      if (row.taxpayer_type) {
        taxpayerOptionsSet.add(row.taxpayer_type);
      }
    }

    const yearlyRows = Array.from(yearlyMap.entries())
      .map(([year, totals]) => ({
        year,
        claimed: totals.claimed,
        used: totals.used,
        utilizationPct: computeUtilization(totals.claimed, totals.used),
      }))
      .sort((a, b) => a.year - b.year);

    const totalClaimed = yearlyRows.reduce((sum, row) => sum + row.claimed, 0);
    const totalUsed = yearlyRows.reduce((sum, row) => sum + row.used, 0);

    const topPrograms = Array.from(programClaimedTotals.entries())
      .map(([program, claimed]) => ({ program, claimed }))
      .sort((a, b) => b.claimed - a.claimed)
      .slice(0, 10);

    const programOptions = Array.from(programOptionsSet).sort((a, b) => a.localeCompare(b));
    const taxpayerOptions = Array.from(taxpayerOptionsSet).sort((a, b) => a.localeCompare(b));

    const yearNumbers = yearlyRows.map((row) => row.year);
    const yearRange = buildYearRange(yearNumbers);

    const responsePayload = {
      ok: true,
      meta: {
        years: yearRange,
        programs: programOptions,
        taxpayerTypes: taxpayerOptions,
        filters: {
          year_from: params.yearFrom ?? null,
          year_to: params.yearTo ?? null,
          program: params.program ?? [],
          taxpayer_type: params.taxpayerType ?? null,
        },
      },
      totals: {
        claimed: totalClaimed,
        used: totalUsed,
        utilizationPct: computeUtilization(totalClaimed, totalUsed),
      },
      yearly: yearlyRows,
      topPrograms,
      raw: params.view === "raw" ? mappedRows : undefined,
    };

    return NextResponse.json(responsePayload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
