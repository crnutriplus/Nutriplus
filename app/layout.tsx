import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NutriPlus | Calculadora de precios",
  description: "Calculadora privada de precios para productos NutriPlus.",
  other: { "codex-preview": "development" },
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="es"><body>{children}</body></html>;
}
