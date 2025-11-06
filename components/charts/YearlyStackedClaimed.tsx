"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type Props = {
  data: Array<Record<string, number | string>>;
  keys: string[];
  valueFormatter: (value: number) => string;
};

export default function YearlyStackedClaimedChart({ data, keys, valueFormatter }: Props) {
  return (
    <div className="h-80 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#cbd5f5" />
          <XAxis dataKey="year" stroke="#0f172a" />
          <YAxis stroke="#0f172a" tickFormatter={valueFormatter} width={100} />
          <Tooltip
            formatter={(value: number) => valueFormatter(value)}
            labelFormatter={(label) => `Year ${label}`}
          />
          <Legend />
          {keys.map((key, index) => (
            <Bar
              key={key}
              dataKey={key}
              stackId="claimed"
              fill={STACK_COLORS[index % STACK_COLORS.length]}
              radius={index === keys.length - 1 ? [4, 4, 0, 0] : 0}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

const STACK_COLORS = [
  "#0ea5e9",
  "#6366f1",
  "#f97316",
  "#84cc16",
  "#ec4899",
  "#14b8a6",
];
