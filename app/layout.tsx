import type { Metadata, Viewport } from "next";
import "./globals.css";
import PwaRegistrar from "@/components/PwaRegistrar";
import PwaRefreshButton from "@/components/PwaRefreshButton";
import { AuthProvider } from "@/lib/authContext";

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
      { url: "/icons/krukkex-icon-192x192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/krukkex-icon-512x512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [
      { url: "/icons/krukkex-icon-152x152.png", sizes: "152x152", type: "image/png" },
      { url: "/icons/krukkex-icon-192x192.png", sizes: "192x192", type: "image/png" },
    ],
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#030712" },
    { media: "(prefers-color-scheme: light)", color: "#030712" },
    { color: "#030712" }
  ],
  colorScheme: "dark",
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="nl" className="dark">
      <head>
        <meta name="theme-color" content="#030712" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="msapplication-navbutton-color" content="#030712" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        <style dangerouslySetInnerHTML={{
          __html: `
            @supports (padding-top: env(safe-area-inset-top)) {
              html { background-color: #030712 !important; }
            }
            :root { --theme-color: #030712; }
            html, body {
              overscroll-behavior: none !important;
              -webkit-overflow-scrolling: touch;
            }
            body {
              touch-action: pan-y;
            }
            @media (display-mode: standalone) {
              header {
                display: block !important;
                visibility: visible !important;
                opacity: 1 !important;
                min-height: 60px !important;
              }
              body {
                position: relative;
              }
            }
            header {
              display: block !important;
              visibility: visible !important;
              opacity: 1 !important;
            }
          `
        }} />
        <script src="/viewport-fix.js" />
      </head>
      <body
        className="min-h-dvh bg-gray-950 text-gray-100 antialiased flex flex-col"
        style={{
          overscrollBehavior: 'none',
          minHeight: 'calc(var(--vh, 1vh) * 100)',
          height: 'calc(var(--vh, 1vh) * 100)'
        }}
      >
        <AuthProvider>
          <PwaRegistrar />
          <PwaRefreshButton />
          {children}
        </AuthProvider>
      </body>
    </html>
  );
}
