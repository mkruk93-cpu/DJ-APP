import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "KrukkeX DJ Stream",
    short_name: "KrukkeX",
    description: "KrukkeX live stream met chat en muziekverzoekjes",
    start_url: "/stream?v=1.1.1",
    scope: "/",
    display: "standalone",
    display_override: ["standalone", "fullscreen", "minimal-ui"],
    orientation: "portrait",
    background_color: "#0b0618",
    theme_color: "#030712",
    icons: [
      {
        src: "/icons/krukkex-icon.svg",
        sizes: "512x512",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/icons/krukkex-icon-maskable.svg",
        sizes: "512x512",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  };
}
