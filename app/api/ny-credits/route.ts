import { NextRequest, NextResponse } from "next/server";
import { socrataQuery } from "@/lib/socrataV3";

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
  };
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

async function getColumnMap(): Promise<ColumnMap> {
  if (cachedColumnMap) {
    return cachedColumnMap;
  }

  const response = await socrataQuery<SocrataResponse>("SELECT * LIMIT 1");
  const columns = response.meta?.view?.columns ?? [];

  const findColumn = (regex: RegExp): string | undefined => {
    return columns.find((column) => {
      const fieldName = column.fieldName ?? "";
      const name = column.name ?? "";
      return regex.test(fieldName) || regex.test(name);
    })?.fieldName;
  };

  const columnMap: ColumnMap = {
    year: findColumn(YEAR_REGEX) ?? "",
    claimed: findColumn(CLAIMED_REGEX),
    used: findColumn(USED_REGEX),
    program: findColumn(PROGRAM_REGEX),
    taxpayerType: findColumn(TAXPAYER_REGEX),
  };

  if (!columnMap.year) {
    throw new Error("Unable to identify year column in Socrata dataset");
  }

  if (!columnMap.claimed) {
    throw new Error("Unable to identify claimed amount column in Socrata dataset");
  }

  if (!columnMap.program) {
    throw new Error("Unable to identify program column in Socrata dataset");
  }

  cachedColumnMap = columnMap;
  return columnMap;
}

function sanitizeValue(value: string): string {
  return value.replace(/'/g, "''");
}

function mapRows(response: SocrataResponse): Record<string, any>[] {
  const columns = response.meta?.view?.columns ?? [];
  return (response.data ?? []).map((row: any) => {
    const record: Record<string, any> = {};
    columns.forEach((column, index) => {
      const key = (column.name || column.fieldName || `col_${index}`).replace(/"/g, "");
      if (Array.isArray(row)) {
        record[key] = row[index];
      } else if (row && typeof row === "object") {
        record[key] = row[column.fieldName ?? key];
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
      const rawResponse = await socrataQuery<SocrataResponse>(csvQuery);
      const rows = mapRows(rawResponse);
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
      socrataQuery<SocrataResponse>(yearlyQuery),
      topProgramsQuery ? socrataQuery<SocrataResponse>(topProgramsQuery) : Promise.resolve(null),
      programsQuery ? socrataQuery<SocrataResponse>(programsQuery) : Promise.resolve(null),
      taxpayerTypesQuery ? socrataQuery<SocrataResponse>(taxpayerTypesQuery) : Promise.resolve(null),
    ]);

    const yearlyRows = mapRows(yearlyResponse).map((row) => {
      const year = Number.parseInt(String(row.year), 10);
      const claimed = toNumber(row.claimed);
      const used = toNumber(row.used);
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
      .map((row) => ({ program: row.program ?? "Unknown", claimed: toNumber(row.claimed) }))
      .filter((row) => row.program !== null && row.program !== undefined);

    const programOptions = programsResponse
      ? mapRows(programsResponse)
          .map((row) => row.program)
          .filter((value) => value !== null && value !== undefined && value !== "")
      : [];

    const taxpayerOptions = taxpayerTypesResponse
      ? mapRows(taxpayerTypesResponse)
          .map((row) => row.taxpayer_type)
          .filter((value) => value !== null && value !== undefined && value !== "")
      : [];

    let rawRows: Record<string, any>[] = [];
    if (params.view === "raw") {
      const rawSelect = buildRawSelect(columns);
      const rawQuery = `${rawSelect} ${whereClause} ORDER BY "${columns.year}" DESC LIMIT 50000`;
      const rawResponse = await socrataQuery<SocrataResponse>(rawQuery);
      rawRows = mapRows(rawResponse).map((row) => {
        const claimed = toNumber(row.claimed);
        const used = toNumber(row.used);
        return {
          year: row.year,
          program: row.program,
          claimed,
          used,
          taxpayer_type: row.taxpayer_type,
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
