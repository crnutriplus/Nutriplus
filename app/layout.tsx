import type { Metadata } from "next";
import { NUTRIPLUS_PUBLIC_VERSION } from "@/lib/public-version";
import "./globals.css";

export const metadata: Metadata = {
  title: `NutriPlus v${NUTRIPLUS_PUBLIC_VERSION} | Calculadora de precios`,
  applicationName: "NutriPlus",
  description: "Inventario, pedidos, encargos y alertas operativas de NutriPlus.",
  manifest: "/manifest.webmanifest",
  other: {
    "codex-preview": "development",
    "nutriplus-public-version": NUTRIPLUS_PUBLIC_VERSION,
  },
  icons: { icon: "/nutriplus-logo.jpg", shortcut: "/nutriplus-logo.jpg", apple: "/nutriplus-logo.jpg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="es-CR"><body>{children}</body></html>;
}
