"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import dynamic from "next/dynamic";

const YearlyStackedClaimedChart = dynamic(() => import("@/components/charts/YearlyStackedClaimed"), {
  ssr: false,
});
const UtilizationLineChart = dynamic(() => import("@/components/charts/UtilizationLineChart"), {
  ssr: false,
});
const TopProgramsBarChart = dynamic(() => import("@/components/charts/TopProgramsBarChart"), {
  ssr: false,
});

type FiltersState = {
  yearFrom?: number;
  yearTo?: number;
  programs: string[];
  taxpayerType?: string;
};

type ApiResponse = {
  ok: boolean;
  meta: {
    years: number[];
    programs: string[];
    taxpayerTypes?: string[];
    filters: {
      year_from: number | null;
      year_to: number | null;
      program: string[];
      taxpayer_type: string | null;
    };
  };
  totals: {
    claimed: number;
    used: number;
    utilizationPct: number;
  };
  yearly: Array<{ year: number; claimed: number; used: number; utilizationPct: number }>;
  topPrograms: Array<{ program: string; claimed: number }>;
  raw?: Array<{
    year: number | string;
    program: string;
    claimed: number;
    used: number;
    taxpayer_type?: string;
    utilizationPct: number;
  }>;
};

const CURRENCY_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

const NUMBER_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
});

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "–";
  return `${NUMBER_FORMATTER.format(value)}%`;
}

export default function NyCreditsPage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [appliedFilters, setAppliedFilters] = useState<FiltersState>({ programs: [] });
  const [draftFilters, setDraftFilters] = useState<FiltersState>({ programs: [] });
  const [programSearch, setProgramSearch] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const abortControllerRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async (filters: FiltersState) => {
    const params = new URLSearchParams();
    params.set("view", "raw");
    if (filters.yearFrom !== undefined) params.set("year_from", String(filters.yearFrom));
    if (filters.yearTo !== undefined) params.set("year_to", String(filters.yearTo));
    if (filters.programs.length > 0) params.set("program", filters.programs.join(","));
    if (filters.taxpayerType) params.set("taxpayer_type", filters.taxpayerType);

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/ny-credits?${params.toString()}`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Request failed (${response.status})`);
      }
      const json = (await response.json()) as ApiResponse;
      if (!json.ok) {
        throw new Error("API returned an error response");
      }
      if (controller.signal.aborted) {
        return;
      }
      setData(json);
    } catch (err) {
      const isAbortError =
        (err instanceof Error && err.name === "AbortError") ||
        (typeof err === "object" && err !== null && "name" in err && (err as { name?: string }).name === "AbortError");
      if (isAbortError || controller.signal.aborted) {
        return;
      }
      setError(err instanceof Error ? err.message : "Unexpected error");
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    fetchData(appliedFilters);
  }, [fetchData, appliedFilters]);

  useEffect(
    () => () => {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (data?.meta?.years?.length) {
      const defaultFrom = data.meta.years[0];
      const defaultTo = data.meta.years[data.meta.years.length - 1];
      setDraftFilters((prev) => ({
        ...prev,
        yearFrom: prev.yearFrom ?? defaultFrom,
        yearTo: prev.yearTo ?? defaultTo,
      }));
      setAppliedFilters((prev) => {
        if (prev.yearFrom === undefined && prev.yearTo === undefined) {
          return { ...prev, yearFrom: defaultFrom, yearTo: defaultTo };
        }
        return prev;
      });
    }
  }, [data?.meta?.years]);

  useEffect(() => {
    setCurrentPage(1);
  }, [appliedFilters]);

  const onApplyFilters = () => {
    if (draftFilters.yearFrom && draftFilters.yearTo && draftFilters.yearFrom > draftFilters.yearTo) {
      setError("Year from cannot exceed year to");
      return;
    }
    setAppliedFilters({
      yearFrom: draftFilters.yearFrom,
      yearTo: draftFilters.yearTo,
      programs: draftFilters.programs,
      taxpayerType: draftFilters.taxpayerType,
    });
  };

  const onResetFilters = () => {
    const defaultFrom = data?.meta.years[0];
    const defaultTo = data?.meta.years[data.meta.years.length - 1];
    const resetFilters: FiltersState = {
      yearFrom: defaultFrom,
      yearTo: defaultTo,
      programs: [],
      taxpayerType: undefined,
    };
    setDraftFilters(resetFilters);
    setAppliedFilters(resetFilters);
    setProgramSearch("");
  };

  const availablePrograms = useMemo(() => {
    const programs = data?.meta.programs ?? [];
    if (!programSearch) return programs;
    const lower = programSearch.toLowerCase();
    return programs.filter((program) => program.toLowerCase().includes(lower));
  }, [data?.meta.programs, programSearch]);

  const taxpayerOptions = useMemo(() => data?.meta.taxpayerTypes ?? [], [data?.meta.taxpayerTypes]);

  const paginatedRows = useMemo(() => {
    const rows = data?.raw ?? [];
    const start = (currentPage - 1) * 25;
    return rows.slice(start, start + 25);
  }, [data?.raw, currentPage]);

  const totalPages = useMemo(() => {
    const total = data?.raw?.length ?? 0;
    return total > 0 ? Math.ceil(total / 25) : 1;
  }, [data?.raw?.length]);

  const csvUrl = useMemo(() => {
    const params = new URLSearchParams();
    params.set("view", "raw");
    params.set("format", "csv");
    if (appliedFilters.yearFrom !== undefined) params.set("year_from", String(appliedFilters.yearFrom));
    if (appliedFilters.yearTo !== undefined) params.set("year_to", String(appliedFilters.yearTo));
    if (appliedFilters.programs.length > 0) params.set("program", appliedFilters.programs.join(","));
    if (appliedFilters.taxpayerType) params.set("taxpayer_type", appliedFilters.taxpayerType);
    return `/api/ny-credits?${params.toString()}`;
  }, [appliedFilters]);

  const programsInScope = useMemo(() => {
    const rows = data?.raw ?? [];
    if (!rows.length) {
      return undefined;
    }
    const uniquePrograms = new Set<string>();
    rows.forEach((row) => {
      if (row.program) {
        uniquePrograms.add(row.program);
      }
    });
    return uniquePrograms.size;
  }, [data?.raw]);

  const stackedChartData = useMemo(() => {
    if (!data?.raw || !data.topPrograms?.length) return [];
    const topFive = data.topPrograms.slice(0, 5).map((program) => program.program);
    const grouped = new Map<number, Record<string, number | string>>();

    data.raw.forEach((entry) => {
      const year = typeof entry.year === "string" ? Number.parseInt(entry.year, 10) : Number(entry.year);
      if (!Number.isFinite(year)) return;
      const claimed = Number(entry.claimed) || 0;
      const program = entry.program || "Unknown";
      if (!grouped.has(year)) {
        const base: Record<string, number | string> = { year };
        topFive.forEach((name) => {
          base[name] = 0;
        });
        base.Others = 0;
        grouped.set(year, base);
      }
      const bucket = grouped.get(year)!;
      if (topFive.includes(program)) {
        bucket[program] = (bucket[program] as number) + claimed;
      } else {
        bucket.Others = (bucket.Others as number) + claimed;
      }
    });

    return Array.from(grouped.values()).sort((a, b) => Number(a.year) - Number(b.year));
  }, [data?.raw, data?.topPrograms]);

  const stackedKeys = useMemo(() => {
    if (!data?.topPrograms?.length) return [];
    const topFive = data.topPrograms.slice(0, 5).map((program) => program.program);
    return [...topFive, "Others"];
  }, [data?.topPrograms]);

  const utilizationLineData = useMemo(() => data?.yearly ?? [], [data?.yearly]);

  const topProgramsData = useMemo(() => data?.topPrograms ?? [], [data?.topPrograms]);

  const handleProgramSelection = (event: ChangeEvent<HTMLSelectElement>) => {
    const options = Array.from(event.target.selectedOptions).map((option) => option.value);
    setDraftFilters((prev) => ({ ...prev, programs: options }));
  };

  const handleTaxpayerChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    setDraftFilters((prev) => ({ ...prev, taxpayerType: value === "" ? undefined : value }));
  };

  const isEmpty = !loading && !error && (data?.raw?.length ?? 0) === 0;

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-7xl space-y-8 px-6 py-10">
        <header className="flex flex-col gap-2 border-b border-slate-200 pb-6">
          <h1 className="text-3xl font-semibold text-slate-900">NY Economic Incentive Tax Credits</h1>
          <p className="max-w-3xl text-slate-600">
            Explore statewide economic incentive tax credit utilization trends. Filter by year range, program,
            and taxpayer type to evaluate how credits are being claimed and used across New York State.
          </p>
        </header>

        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Filters</h2>
          <div className="mt-4 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-slate-700" htmlFor="year-from">
                Year from
              </label>
              <select
                id="year-from"
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none"
                value={draftFilters.yearFrom ?? ""}
                onChange={(event) =>
                  setDraftFilters((prev) => ({ ...prev, yearFrom: Number(event.target.value) || undefined }))
                }
              >
                {(data?.meta.years ?? []).map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-slate-700" htmlFor="year-to">
                Year to
              </label>
              <select
                id="year-to"
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none"
                value={draftFilters.yearTo ?? ""}
                onChange={(event) =>
                  setDraftFilters((prev) => ({ ...prev, yearTo: Number(event.target.value) || undefined }))
                }
              >
                {(data?.meta.years ?? []).map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-2 md:col-span-2 lg:col-span-1">
              <label className="text-sm font-medium text-slate-700" htmlFor="program-search">
                Programs
              </label>
              <input
                id="program-search"
                type="text"
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none"
                placeholder="Search programs"
                value={programSearch}
                onChange={(event) => setProgramSearch(event.target.value)}
              />
              <select
                multiple
                size={6}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-inner focus:border-slate-500 focus:outline-none"
                value={draftFilters.programs}
                onChange={handleProgramSelection}
              >
                {availablePrograms.map((program) => (
                  <option key={program} value={program}>
                    {program}
                  </option>
                ))}
              </select>
              <p className="text-xs text-slate-500">Hold Ctrl / Cmd to select multiple programs.</p>
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-slate-700" htmlFor="taxpayer-type">
                Taxpayer type
              </label>
              <select
                id="taxpayer-type"
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none"
                value={draftFilters.taxpayerType ?? ""}
                onChange={handleTaxpayerChange}
              >
                <option value="">All taxpayer types</option>
                {taxpayerOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={onApplyFilters}
              className="rounded-full bg-slate-900 px-5 py-2 text-sm font-medium text-white shadow hover:bg-slate-700"
            >
              Apply filters
            </button>
            <button
              type="button"
              onClick={onResetFilters}
              className="rounded-full border border-slate-300 px-5 py-2 text-sm font-medium text-slate-700 hover:border-slate-400"
            >
              Reset
            </button>
            <a
              className="rounded-full border border-slate-300 px-5 py-2 text-sm font-medium text-slate-700 hover:border-slate-400"
              href={csvUrl}
            >
              Download CSV
            </a>
          </div>
        </section>

        {loading && (
          <div className="flex items-center justify-center rounded-xl border border-slate-200 bg-white p-10 shadow-sm">
            <p className="text-slate-600">Loading dashboard…</p>
          </div>
        )}

        {error && !loading && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-red-700">
            Unable to load data: {error}
          </div>
        )}

        {isEmpty && (
          <div className="rounded-xl border border-slate-200 bg-white p-6 text-center text-slate-600 shadow-sm">
            No records match the current filters.
          </div>
        )}

        {!loading && !error && data && (
          <>
            <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <KpiCard label="Claimed" value={CURRENCY_FORMATTER.format(data.totals.claimed)} />
              <KpiCard label="Used" value={CURRENCY_FORMATTER.format(data.totals.used)} />
              <KpiCard label="Utilization" value={formatPercent(data.totals.utilizationPct)} />
              <KpiCard
                label="Programs in scope"
                value={programsInScope !== undefined ? programsInScope.toString() : "–"}
              />
            </section>

            <section className="grid gap-6 lg:grid-cols-2">
              <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-slate-900">Claimed by year & program</h2>
                  <span className="text-xs text-slate-500">Top 5 programs by claimed amount</span>
                </div>
                {stackedChartData.length > 0 ? (
                  <YearlyStackedClaimedChart
                    data={stackedChartData}
                    keys={stackedKeys}
                    valueFormatter={CURRENCY_FORMATTER.format.bind(CURRENCY_FORMATTER)}
                  />
                ) : (
                  <p className="text-sm text-slate-500">Insufficient data to render chart.</p>
                )}
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-lg font-semibold text-slate-900">Utilization rate</h2>
                  <span className="text-xs text-slate-500">Used / Claimed</span>
                </div>
                {utilizationLineData.length > 0 ? (
                  <UtilizationLineChart data={utilizationLineData} valueFormatter={(value) => formatPercent(value)} />
                ) : (
                  <p className="text-sm text-slate-500">Insufficient data to render chart.</p>
                )}
              </div>
            </section>

            <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold text-slate-900">Top programs by claimed</h2>
                <span className="text-xs text-slate-500">Top 10 programs</span>
              </div>
              {topProgramsData.length > 0 ? (
                <TopProgramsBarChart data={topProgramsData} valueFormatter={CURRENCY_FORMATTER.format.bind(CURRENCY_FORMATTER)} />
              ) : (
                <p className="text-sm text-slate-500">No program data available.</p>
              )}
            </section>

            <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold text-slate-900">Raw records</h2>
                <span className="text-xs text-slate-500">Showing {(data.raw?.length ?? 0).toLocaleString()} records</span>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-200 text-sm">
                  <thead className="bg-slate-100 text-left text-xs font-semibold uppercase tracking-wide text-slate-600">
                    <tr>
                      <th className="px-4 py-3">Year</th>
                      <th className="px-4 py-3">Program</th>
                      <th className="px-4 py-3 text-right">Claimed</th>
                      <th className="px-4 py-3 text-right">Used</th>
                      <th className="px-4 py-3">Taxpayer type</th>
                      <th className="px-4 py-3 text-right">Utilization</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 bg-white">
                    {paginatedRows.map((row, index) => (
                      <tr key={`${row.year}-${row.program}-${index}`} className="hover:bg-slate-50">
                        <td className="px-4 py-3 font-medium text-slate-800">{row.year}</td>
                        <td className="px-4 py-3 text-slate-700">{row.program}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{CURRENCY_FORMATTER.format(row.claimed)}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{CURRENCY_FORMATTER.format(row.used)}</td>
                        <td className="px-4 py-3 text-slate-700">{row.taxpayer_type ?? "–"}</td>
                        <td className="px-4 py-3 text-right tabular-nums">{formatPercent(row.utilizationPct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-4 flex items-center justify-between text-sm text-slate-600">
                <span>
                  Page {currentPage} of {totalPages}
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={currentPage <= 1}
                    onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                    className="rounded-full border border-slate-300 px-4 py-1 font-medium text-slate-700 transition enabled:hover:border-slate-400 enabled:hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    disabled={currentPage >= totalPages}
                    onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                    className="rounded-full border border-slate-300 px-4 py-1 font-medium text-slate-700 transition enabled:hover:border-slate-400 enabled:hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>
              </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}

type KpiCardProps = {
  label: string;
  value: string;
};

function KpiCard({ label, value }: KpiCardProps) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <p className="text-sm font-medium text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-slate-900">{value}</p>
    </div>
  );
}
