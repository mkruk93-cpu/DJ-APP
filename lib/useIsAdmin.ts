import { useAuth } from '@/lib/authContext';
import { isRadioAdmin } from '@/lib/auth';

/**
 * Custom hook to determine if the current user has admin privileges.
 * An admin is either a user with the radio admin token or the user with the username 'KrukkeX'.
 * @returns {boolean} True if the user is an admin, false otherwise.
 */
export function useIsAdmin(): boolean {
  const { userAccount } = useAuth();
  const hasToken = isRadioAdmin();
  // TODO: Make 'KrukkeX' a configurable value
  return hasToken || userAccount?.username === 'KrukkeX';
}
