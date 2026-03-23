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
    } else if (user && !userAccount?.approved) {
      // User logged in but not approved - they should see pending message on login page
      router.replace("/login");
    } else {
      router.replace("/login");
    }
  }, [user, userAccount, loading, router]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-white">Laden...</div>
    </div>
  );
}
