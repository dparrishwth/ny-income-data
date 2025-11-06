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

const YEAR_REGEX = /(calendar|tax).*year/i;
const CLAIMED_REGEX = /(claimed|amount|value|approved)/i;
const USED_REGEX = /(used|utilized|applied)/i;
const PROGRAM_REGEX = /(program|credit.*name|credit.*type|description)/i;
const TAXPAYER_REGEX = /(taxpayer|entity).*type/i;

function findColumnFromList(
  candidates: (SocrataColumn | string)[],
  regex: RegExp,
): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      if (regex.test(candidate)) {
        return candidate;
      }
      continue;
    }

    const fieldName = candidate.fieldName ?? "";
    const name = candidate.name ?? "";
    if (regex.test(fieldName)) {
      return fieldName;
    }
    if (regex.test(name)) {
      return candidate.fieldName ?? name;
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
    year: findColumnFromList(columns, YEAR_REGEX) ?? "",
    claimed: findColumnFromList(columns, CLAIMED_REGEX),
    used: findColumnFromList(columns, USED_REGEX),
    program: findColumnFromList(columns, PROGRAM_REGEX),
    taxpayerType: findColumnFromList(columns, TAXPAYER_REGEX),
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
        year: columnMap.year || findColumnFromList(sampleColumns, YEAR_REGEX) || "",
        claimed: columnMap.claimed || findColumnFromList(sampleColumns, CLAIMED_REGEX),
        used: columnMap.used || findColumnFromList(sampleColumns, USED_REGEX),
        program: columnMap.program || findColumnFromList(sampleColumns, PROGRAM_REGEX),
        taxpayerType:
          columnMap.taxpayerType || findColumnFromList(sampleColumns, TAXPAYER_REGEX),
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

export async function GET(req: NextRequest) {
  try {
    const params = parseSearchParams(req);
    const columns = await getColumnMap();

    const whereClause = buildWhere(params, columns);

    if (params.format === "csv") {
      const rawSelect = buildRawSelect(columns);
      const csvQuery = `${rawSelect} ${whereClause} ORDER BY "${columns.year}" DESC LIMIT 50000`;
      const rawResponse = await socrataQuery<SocrataResponse | Record<string, any>[]>(csvQuery);
      const rows = mapRows(rawResponse);
      const csvLines = ["year,program,claimed,used,taxpayer_type"];
      for (const row of rows) {
        const yearValue = row.year ?? row[columns.year];
        const programValue = row.program ?? (columns.program ? row[columns.program] : undefined);
        const claimedValue = row.claimed ?? (columns.claimed ? row[columns.claimed] : undefined);
        const usedValue = row.used ?? (columns.used ? row[columns.used] : undefined);
        const taxpayerValue = row.taxpayer_type ?? (columns.taxpayerType ? row[columns.taxpayerType] : undefined);
        const values = [yearValue, programValue, claimedValue, usedValue, taxpayerValue]
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
      const csvContent = csvLines.join("\n");
      return new Response(csvContent, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": "attachment; filename=ny-credits.csv",
        },
      });
    }

    const claimedExpr = columns.claimed ? `COALESCE("${columns.claimed}", 0)` : "0";
    const usedExpr = columns.used ? `COALESCE("${columns.used}", 0)` : "0";

    const yearlyQuery = `SELECT "${columns.year}" AS year, SUM(${claimedExpr}) AS claimed, SUM(${usedExpr}) AS used ${
      whereClause ? `${whereClause}` : ""
    } GROUP BY "${columns.year}" ORDER BY "${columns.year}"`;

    const topProgramsQuery = columns.program
      ? `SELECT "${columns.program}" AS program, SUM(${claimedExpr}) AS claimed ${
          whereClause ? `${whereClause}` : ""
        } GROUP BY "${columns.program}" ORDER BY claimed DESC LIMIT 10`
      : undefined;

    const programsQuery = columns.program
      ? `SELECT DISTINCT "${columns.program}" AS program ${
          whereClause ? `${whereClause}` : ""
        } ORDER BY program`
      : undefined;

    const taxpayerTypesQuery = columns.taxpayerType
      ? `SELECT DISTINCT "${columns.taxpayerType}" AS taxpayer_type ${
          whereClause ? `${whereClause}` : ""
        } ORDER BY taxpayer_type`
      : undefined;

    const [yearlyResponse, topProgramsResponse, programsResponse, taxpayerTypesResponse] = await Promise.all([
      socrataQuery<SocrataResponse | Record<string, any>[]>(yearlyQuery),
      topProgramsQuery
        ? socrataQuery<SocrataResponse | Record<string, any>[]>(topProgramsQuery)
        : Promise.resolve(null),
      programsQuery
        ? socrataQuery<SocrataResponse | Record<string, any>[]>(programsQuery)
        : Promise.resolve(null),
      taxpayerTypesQuery
        ? socrataQuery<SocrataResponse | Record<string, any>[]>(taxpayerTypesQuery)
        : Promise.resolve(null),
    ]);

    const yearlyRows = mapRows(yearlyResponse).map((row) => {
      const yearValue = row.year ?? row[columns.year];
      const claimedValue = row.claimed ?? row[columns.claimed ?? "claimed"];
      const usedValue = row.used ?? row[columns.used ?? "used"];
      const year = Number.parseInt(String(yearValue), 10);
      const claimed = toNumber(claimedValue);
      const used = toNumber(usedValue);
      return {
        year,
        claimed,
        used,
        utilizationPct: computeUtilization(claimed, used),
      };
    });

    yearlyRows.sort((a, b) => a.year - b.year);

    const totalClaimed = yearlyRows.reduce((sum, row) => sum + row.claimed, 0);
    const totalUsed = yearlyRows.reduce((sum, row) => sum + row.used, 0);

    const topProgramRows = topProgramsResponse ? mapRows(topProgramsResponse) : [];
    const topPrograms = topProgramRows
      .map((row) => {
        const programValue = row.program ?? (columns.program ? row[columns.program] : undefined);
        const claimedValue = row.claimed ?? (columns.claimed ? row[columns.claimed] : undefined);
        return { program: programValue ?? "Unknown", claimed: toNumber(claimedValue) };
      })
      .filter((row) => row.program !== null && row.program !== undefined);

    const programOptions = programsResponse
      ? mapRows(programsResponse)
          .map((row) => row.program ?? (columns.program ? row[columns.program] : undefined))
          .filter((value) => value !== null && value !== undefined && value !== "")
      : [];

    const taxpayerOptions = taxpayerTypesResponse
      ? mapRows(taxpayerTypesResponse)
          .map((row) => row.taxpayer_type ?? (columns.taxpayerType ? row[columns.taxpayerType] : undefined))
          .filter((value) => value !== null && value !== undefined && value !== "")
      : [];

    let rawRows: Record<string, any>[] = [];
    if (params.view === "raw") {
      const rawSelect = buildRawSelect(columns);
      const rawQuery = `${rawSelect} ${whereClause} ORDER BY "${columns.year}" DESC LIMIT 50000`;
      const rawResponse = await socrataQuery<SocrataResponse | Record<string, any>[]>(rawQuery);
      rawRows = mapRows(rawResponse).map((row) => {
        const yearValue = row.year ?? row[columns.year];
        const programValue = row.program ?? (columns.program ? row[columns.program] : undefined);
        const claimedValue = row.claimed ?? (columns.claimed ? row[columns.claimed] : undefined);
        const usedValue = row.used ?? (columns.used ? row[columns.used] : undefined);
        const taxpayerValue =
          row.taxpayer_type ?? (columns.taxpayerType ? row[columns.taxpayerType] : undefined);
        const claimed = toNumber(claimedValue);
        const used = toNumber(usedValue);
        return {
          year: yearValue,
          program: programValue,
          claimed,
          used,
          taxpayer_type: taxpayerValue,
          utilizationPct: computeUtilization(claimed, used),
        };
      });
    }

    const years = yearlyRows.map((row) => row.year).filter((value) => Number.isFinite(value));
    const minYear = years.length > 0 ? Math.min(...years) : undefined;
    const maxYear = years.length > 0 ? Math.max(...years) : undefined;
    const yearRange: number[] = [];
    if (minYear !== undefined && maxYear !== undefined) {
      for (let year = minYear; year <= maxYear; year += 1) {
        yearRange.push(year);
      }
    }

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
      raw: params.view === "raw" ? rawRows : undefined,
    };

    return NextResponse.json(responsePayload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
