"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type Props = {
  data: Array<{ program: string; claimed: number }>;
  valueFormatter: (value: number) => string;
};

export default function TopProgramsBarChart({ data, valueFormatter }: Props) {
  return (
    <div className="h-96 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={[...data].reverse()} layout="vertical" margin={{ left: 80, right: 40 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#cbd5f5" />
          <XAxis type="number" tickFormatter={valueFormatter} stroke="#0f172a" />
          <YAxis dataKey="program" type="category" width={200} stroke="#0f172a" />
          <Tooltip formatter={(value: number) => valueFormatter(value)} />
          <Bar dataKey="claimed" fill="#2563eb" radius={[0, 8, 8, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
