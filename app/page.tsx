import Link from "next/link";

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-6 text-center">
      <h1 className="text-3xl font-semibold">NY Income Data Explorer</h1>
      <p className="max-w-2xl text-lg text-slate-600">
        Explore New York State economic incentive tax credit utilization data with the
        interactive dashboard.
      </p>
      <Link
        className="rounded-full bg-slate-900 px-6 py-3 text-white shadow transition hover:bg-slate-700"
        href="/ny-credits"
      >
        Open dashboard
      </Link>
    </main>
  );
}
