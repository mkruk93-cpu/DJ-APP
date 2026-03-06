import type { Metadata, Viewport } from "next";
import "./globals.css";
import PwaRegistrar from "@/components/PwaRegistrar";
import PwaRefreshButton from "@/components/PwaRefreshButton";

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
            /* Force notification bar color on all platforms */
            @supports (padding-top: env(safe-area-inset-top)) {
              html { background-color: #030712 !important; }
            }
            /* Override any purple theme colors */
            :root { --theme-color: #030712; }
            /* Disable pull-to-refresh on mobile */
            html, body {
              overscroll-behavior: none !important;
              -webkit-overflow-scrolling: touch;
            }
            /* Prevent refresh gestures */
            body {
              touch-action: pan-x pan-y;
            }
            /* PWA specific fixes */
            @media (display-mode: standalone) {
              /* Force header visibility in PWA mode */
              header {
                display: block !important;
                visibility: visible !important;
                opacity: 1 !important;
              }
              /* Prevent content jumping in PWA */
              body {
                position: relative;
              }
            }
          `
        }} />
      </head>
      <body className="min-h-dvh bg-gray-950 text-gray-100 antialiased" style={{ overscrollBehavior: 'none' }}>
        <PwaRegistrar />
        <PwaRefreshButton />
        {children}
      </body>
    </html>
  );
}
