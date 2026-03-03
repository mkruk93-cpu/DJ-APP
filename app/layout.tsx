import type { Metadata, Viewport } from "next";
import "./globals.css";
import PwaRegistrar from "@/components/PwaRegistrar";

export const metadata: Metadata = {
  title: "KrukkeX DJ Stream",
  description: "Live stream met chat en muziekverzoekjes",
  applicationName: "KrukkeX",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "KrukkeX",
  },
  icons: {
    icon: [
      { url: "/icons/krukkex-icon.svg", type: "image/svg+xml" },
      { url: "/icons/krukkex-icon-maskable.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/icons/krukkex-icon.svg", type: "image/svg+xml" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#7c3aed",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="nl" className="dark">
      <body className="min-h-dvh bg-gray-950 text-gray-100 antialiased">
        <PwaRegistrar />
        {children}
      </body>
    </html>
  );
}
