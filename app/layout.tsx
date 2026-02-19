import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DJ Stream",
  description: "Live stream met chat en muziekverzoekjes",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="nl" className="dark">
      <body className="min-h-dvh bg-gray-950 text-gray-100 antialiased">
        {children}
      </body>
    </html>
  );
}
