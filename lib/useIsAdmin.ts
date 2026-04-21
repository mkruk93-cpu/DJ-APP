import { useAuth } from '@/lib/authContext';
import { isConfiguredAdminUser } from '@/lib/adminIdentity';
import { useEffect, useState, useRef } from 'react';

/**
 * Custom hook to determine if the current user has admin privileges.
 * Admin UI is only available to the configured approved admin account.
 * @returns {boolean} True if the user is an admin, false otherwise.
 */
export function useIsAdmin(): boolean {
  const { userAccount, loading: authLoading } = useAuth();
  const [isAdmin, setIsAdmin] = useState(false);
  const hasCheckedRef = useRef(false);

  useEffect(() => {
    // Don't determine admin status while auth is still loading
    // But once we've checked, don't reset to false just because loading becomes true again
    if (authLoading && hasCheckedRef.current) {
      return;
    }

    const isUserAdmin = isConfiguredAdminUser(userAccount);
    
    if (isUserAdmin || !authLoading) {
      setIsAdmin(isUserAdmin);
      hasCheckedRef.current = true;
    }
  }, [userAccount, authLoading]);

  return isAdmin;
}
