import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "KrukkeX DJ Stream",
    short_name: "KrukkeX",
    description: "KrukkeX live stream met chat en muziekverzoekjes",
    start_url: "/stream",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0b0618",
    theme_color: "#7c3aed",
    icons: [
      {
        src: "/icons/krukkex-icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/icons/krukkex-icon-maskable.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  };
}
