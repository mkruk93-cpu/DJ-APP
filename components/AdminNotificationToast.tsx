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

  // Check if current user is KrukkeX admin - more robust detection with fallback
  const adminEmail = process.env.NEXT_PUBLIC_ADMIN_EMAIL || '';
  const isAdmin = userAccount?.username === "KrukkeX" || 
                  user?.email?.toLowerCase().includes("krukke") ||
                  user?.email?.toLowerCase() === adminEmail.toLowerCase() ||
                  userAccount?.username?.toLowerCase().includes("admin") ||
                  false;

  useEffect(() => {
    console.log('[AdminToast] Checking admin status:', { 
      username: userAccount?.username, 
      email: user?.email, 
      isAdmin,
      adminEmail
    });
  }, [user, userAccount, isAdmin, adminEmail]);

  useEffect(() => {
    console.log('[AdminToast] Setting up, isAdmin:', isAdmin);
    if (!isAdmin) {
      console.log('[AdminToast] Not admin, skipping');
      return;
    }

    let intervalId: NodeJS.Timeout;
    let isRealtimeWorking = false;

    // Try realtime first
    const channel = getSupabase()
      .channel('admin-user-approvals')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'user_approvals',
          filter: 'approved=eq.false'
        },
        async (payload) => {
          console.log('[AdminToast] Realtime: New approval detected');
          isRealtimeWorking = true;
          await processApproval(payload.new);
        }
      )
      .subscribe((status) => {
        console.log('[AdminToast] Realtime status:', status);
        if (status === 'SUBSCRIBED') {
          isRealtimeWorking = true;
        }
      });

    // Fallback polling every 10 seconds (in case realtime doesn't work)
    const pollForApprovals = async () => {
      if (isRealtimeWorking) return; // Skip polling if realtime is working
      
      try {
        const { data, error } = await getSupabase()
          .from('user_approvals')
          .select('*')
          .eq('approved', false)
          .order('requested_at', { ascending: false })
          .limit(1);

        if (error) {
          console.error('[AdminToast] Polling error:', error);
          return;
        }

        if (data && data.length > 0 && !pendingApproval) {
          console.log('[AdminToast] Polling: Found new approval');
          await processApproval(data[0]);
        }
      } catch (err) {
        console.error('[AdminToast] Polling failed:', err);
      }
    };

    // Start polling
    intervalId = setInterval(pollForApprovals, 10000);
    // Initial poll
    pollForApprovals();

    return () => {
      clearInterval(intervalId);
      getSupabase().removeChannel(channel);
    };
  }, [isAdmin, pendingApproval]);

  const processApproval = async (approvalData: any) => {
    try {
      const { data: userData, error } = await getSupabase()
        .from('user_accounts')
        .select('username, real_name')
        .eq('id', approvalData.user_id)
        .single();

      if (error) {
        console.error('[AdminToast] Error fetching user details:', error);
        return;
      }

      const approval: UserApproval = {
        id: approvalData.id,
        user_id: approvalData.user_id,
        email: approvalData.email,
        username: userData?.username || null,
        real_name: userData?.real_name || null,
        requested_at: approvalData.requested_at
      };

      console.log('[AdminToast] Showing approval:', approval);
      setPendingApproval(approval);
      setIsVisible(true);
    } catch (err) {
      console.error('[AdminToast] Error processing approval:', err);
    }
  };

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
    // Debug indicator - alleen zichtbaar voor admin testing
    if (isAdmin) {
      return (
        <div className="fixed bottom-4 left-4 z-40 rounded bg-gray-800 px-2 py-1 text-xs text-gray-400">
          Admin Mode Active - Waiting for registrations...
        </div>
      );
    }
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
