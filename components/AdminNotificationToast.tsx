"use client";

import { useState, useEffect } from "react";
import { getSupabase } from "@/lib/supabaseClient";
import { useAuth } from "@/lib/authContext";

interface UserApproval {
  id: string;
  user_id: string;
  email: string;
  username: string | null;
  real_name: string | null;
  requested_at: string;
}

interface AdminNotificationToastProps {
  onApprovalComplete: () => void;
}

export default function AdminNotificationToast({ onApprovalComplete }: AdminNotificationToastProps) {
  const { user, userAccount } = useAuth();
  const [pendingApproval, setPendingApproval] = useState<UserApproval | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  // Check if current user is KrukkeX admin
  const isAdmin = userAccount?.username === "KrukkeX" || user?.email?.includes("krukke");

  useEffect(() => {
    if (!isAdmin) return;

    // Listen for new user approvals in real-time
    const subscription = getSupabase()
      .channel('user-approvals')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'user_approvals',
          filter: 'approved=eq.false'
        },
        async (payload) => {
          console.log('[Admin] New user approval detected:', payload);
          
          // Get full user details
          const { data: userData } = await getSupabase()
            .from('user_accounts')
            .select('username, real_name')
            .eq('id', payload.new.user_id)
            .single();

          const approval: UserApproval = {
            id: payload.new.id,
            user_id: payload.new.user_id,
            email: payload.new.email,
            username: userData?.username || null,
            real_name: userData?.real_name || null,
            requested_at: payload.new.requested_at
          };

          setPendingApproval(approval);
          setIsVisible(true);
        }
      )
      .subscribe();

    return () => {
      subscription.unsubscribe();
    };
  }, [isAdmin]);

  const handleApprove = async () => {
    if (!pendingApproval) return;

    try {
      const supabase = getSupabase();
      
      // Update approval
      await supabase
        .from('user_approvals')
        .update({
          approved: true,
          approved_at: new Date().toISOString(),
          approved_by: userAccount?.username || 'admin'
        })
        .eq('id', pendingApproval.id);

      // Update user account
      await supabase
        .from('user_accounts')
        .update({
          approved: true,
          approved_at: new Date().toISOString(),
          approved_by: userAccount?.username || 'admin'
        })
        .eq('id', pendingApproval.user_id);

      // Hide toast and notify parent
      setIsVisible(false);
      setPendingApproval(null);
      onApprovalComplete();
      
    } catch (err) {
      console.error('Error approving user:', err);
      alert('Fout bij goedkeuren gebruiker');
    }
  };

  const handleReject = async () => {
    if (!pendingApproval) return;

    try {
      const supabase = getSupabase();
      const ADMIN_PASSWORD = process.env.NEXT_PUBLIC_ADMIN_PASSWORD || "admin";

      // Delete approval
      await supabase
        .from('user_approvals')
        .delete()
        .eq('id', pendingApproval.id);

      // Delete user account
      await supabase
        .from('user_accounts')
        .delete()
        .eq('id', pendingApproval.user_id);

      // Delete auth user via API
      await fetch('/api/admin/delete-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          userId: pendingApproval.user_id, 
          secret: ADMIN_PASSWORD 
        })
      });

      // Hide toast and notify parent
      setIsVisible(false);
      setPendingApproval(null);
      onApprovalComplete();
      
    } catch (err) {
      console.error('Error rejecting user:', err);
      alert('Fout bij afwijzen gebruiker');
    }
  };

  if (!isAdmin || !isVisible || !pendingApproval) {
    return null;
  }

  return (
    <div className="fixed top-4 right-4 z-50 max-w-md animate-pulse">
      <div className="rounded-lg border border-violet-500/50 bg-violet-950/90 p-4 shadow-lg shadow-violet-500/20 backdrop-blur-sm">
        <div className="mb-3 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-violet-500 text-sm font-bold text-white">
            !
          </div>
          <h3 className="font-semibold text-white">Nieuwe Registratie</h3>
        </div>
        
        <div className="mb-4 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-400">Email:</span>
            <span className="font-medium text-white">{pendingApproval.email}</span>
          </div>
          {pendingApproval.username && (
            <div className="flex justify-between">
              <span className="text-gray-400">Username:</span>
              <span className="font-medium text-white">{pendingApproval.username}</span>
            </div>
          )}
          {pendingApproval.real_name && (
            <div className="flex justify-between">
              <span className="text-gray-400">Naam:</span>
              <span className="font-medium text-white">{pendingApproval.real_name}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-gray-400">Aangevraagd:</span>
            <span className="font-medium text-white">
              {new Date(pendingApproval.requested_at).toLocaleString('nl-NL', {
                hour: '2-digit',
                minute: '2-digit'
              })}
            </span>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={handleApprove}
            className="flex-1 rounded bg-green-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-green-500"
          >
            ✅ Goedkeuren
          </button>
          <button
            onClick={handleReject}
            className="flex-1 rounded bg-red-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-red-500"
          >
            ❌ Afwijzen
          </button>
        </div>
      </div>
    </div>
  );
}
