import { useAuth } from '@/lib/authContext';
import { isRadioAdmin } from '@/lib/auth';
import { useEffect, useState } from 'react';

/**
 * Custom hook to determine if the current user has admin privileges.
 * An admin is either a user with the radio admin token or the user with the username 'KrukkeX'.
 * @returns {boolean} True if the user is an admin, false otherwise.
 */
export function useIsAdmin(): boolean {
  const { userAccount, loading: authLoading } = useAuth();
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    // Don't determine admin status while auth is still loading
    if (authLoading) {
      setIsAdmin(false);
      return;
    }

    const hasToken = isRadioAdmin();
    const username = (userAccount?.username ?? "").trim().toLowerCase();
    setIsAdmin(hasToken || username === 'krukkex');
  }, [userAccount, authLoading]);

  return isAdmin;
}
