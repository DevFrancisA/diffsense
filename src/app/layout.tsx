import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DiffSense | Code review intelligence",
  description: "Context-aware code review and regression testing workspace.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
