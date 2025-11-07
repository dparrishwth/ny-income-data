"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type Props = {
  data: Array<{ year: number; utilizationPct: number }>;
  valueFormatter: (value: number) => string;
};

export default function UtilizationLineChart({ data, valueFormatter }: Props) {
  return (
    <div className="h-80 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#cbd5f5" />
          <XAxis dataKey="year" stroke="#0f172a" />
          <YAxis stroke="#0f172a" tickFormatter={valueFormatter} width={80} domain={[0, 100]} />
          <Tooltip formatter={(value: number) => valueFormatter(value)} labelFormatter={(label) => `Year ${label}`} />
          <Line type="monotone" dataKey="utilizationPct" stroke="#2563eb" strokeWidth={3} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
