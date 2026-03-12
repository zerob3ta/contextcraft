import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MarketCraft — Context Markets Agent Sim",
  description:
    "A pixel-art prediction market simulation where AI agents create, price, and trade markets in real-time.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
