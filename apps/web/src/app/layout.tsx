import type { Metadata } from "next";
import "./globals.css";
import { Frame } from "@/components/Frame";
import { AccountProvider } from "@/components/AccountProvider";

export const metadata: Metadata = {
  title: "Polymarket Trading Dashboard",
  description: "Polymarket market browser, order book, paper trading, and synthetic stop-loss dashboard."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AccountProvider>
          <Frame>{children}</Frame>
        </AccountProvider>
      </body>
    </html>
  );
}
