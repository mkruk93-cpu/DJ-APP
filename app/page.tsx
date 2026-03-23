"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/authContext";

export default function HomePage() {
  const router = useRouter();
  const { user, userAccount, loading } = useAuth();

  useEffect(() => {
    if (loading) return;

    if (user && userAccount?.approved) {
      router.replace("/stream");
    } else {
      // Hard redirect naar login voor alle andere gevallen (uitgelogd, niet approved, etc.)
      // Dit voorkomt dat oude cached versies van deze pagina zichtbaar blijven.
      window.location.replace("/login");
    }
  }, [user, userAccount, loading, router]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-white">Laden...</div>
    </div>
  );
}
