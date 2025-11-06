import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NY Economic Incentive Tax Credits",
  description: "Dashboard for New York State Economic Incentive Tax Credit Utilization",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
