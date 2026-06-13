"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Briefcase, ClipboardList, LayoutDashboard, ShieldAlert, Trophy } from "lucide-react";
import { AccountSummary } from "./AccountSummary";

const nav = [
  { href: "/", label: "Football", icon: LayoutDashboard },
  { href: "/mlb", label: "MLB", icon: Trophy },
  { href: "/positions", label: "Positions", icon: Briefcase },
  { href: "/orders", label: "Orders", icon: ClipboardList },
  { href: "/stop-loss", label: "Stop Loss", icon: ShieldAlert }
];

export function Frame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="min-h-screen">
      <aside className="fixed inset-y-0 left-0 hidden w-60 border-r border-line bg-white md:block">
        <div className="flex h-14 items-center gap-2 border-b border-line px-4 font-semibold">
          <BarChart3 className="h-5 w-5" />
          PolyTrader
        </div>
        <nav className="p-2">
          {nav.map((item) => {
            const Icon = item.icon;
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`mb-1 flex h-10 items-center gap-3 rounded-md px-3 text-sm font-medium ${
                  active ? "bg-ink text-white" : "text-slate-700 hover:bg-panel"
                }`}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <div className="md:pl-60">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-line bg-white px-4">
          <div className="text-sm font-semibold">Trading Dashboard</div>
          <AccountSummary />
        </header>
        <main className="p-4">{children}</main>
      </div>
    </div>
  );
}
