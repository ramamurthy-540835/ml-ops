import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "ClimateReview AI",
  description: "Evidence synthesis workbench for IPCC Working Group II",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
