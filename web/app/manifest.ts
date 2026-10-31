import type { MetadataRoute } from "next";

/**
 * PWA manifest.
 *
 * Installability is what makes Web Push work on iOS (16.4+ only delivers to a
 * site added to the Home Screen), and browsers require both a 192px and a
 * 512px icon plus a service worker for the install prompt.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Sua — study smarter",
    short_name: "Sua",
    description:
      "Turn lectures, slides and notes into summaries, flashcards and quizzes that work offline.",
    start_url: "/app/home",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#FFF8E8",
    theme_color: "#005B45",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
