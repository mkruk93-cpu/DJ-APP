"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/authContext";
import { useState } from "react";

export default function HomePage() {
  const router = useRouter();
  const { user, userAccount, loading } = useAuth();
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
    // Safety redirect if hanging too long
    const timeout = setTimeout(() => {
      console.log("[HomePage] Safety timeout redirect to /login");
      router.replace("/login");
    }, 12000);
    return () => clearTimeout(timeout);
  }, [router]);

  useEffect(() => {
    if (!isClient || loading) return;

    if (user && !userAccount) return;
    
    if (user && userAccount?.approved) {
      router.replace("/stream");
    } else {
      router.replace("/login");
    }
  }, [isClient, user, userAccount, loading, router]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-white">Laden...</div>
    </div>
  );
}
