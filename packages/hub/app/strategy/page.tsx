import NavBar from "@/components/NavBar";

export default function StrategyPage() {
  return (
    <div className="min-h-screen bg-neutral-50 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100">
      <NavBar />
      <main className="max-w-3xl mx-auto px-4 py-16 text-center">
        <h1 className="text-lg font-bold mb-3">Strategy</h1>
        <p className="text-sm text-neutral-500 max-w-md mx-auto">
          Strategy analysis is handled by the Manager agent.
          View agent activity on the{" "}
          <a href="/agents" className="text-amber-500 hover:text-amber-400 underline transition">
            Agents page
          </a>.
        </p>
      </main>
    </div>
  );
}
