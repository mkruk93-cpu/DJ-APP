"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { User, Session, AuthError } from '@supabase/supabase-js';
import { getSupabase } from '@/lib/supabaseClient';

interface UserAccount {
  id: string;
  email: string;
  username: string;
  approved: boolean;
  approved_at: string | null;
  approved_by: string | null;
  created_at: string;
  last_login: string | null;
}

export interface AuthContextType {
  user: User | null;
  session: Session | null;
  userAccount: UserAccount | null;
  loading: boolean;
  signUp: (email: string, password: string, username?: string, realName?: string) => Promise<{ error: AuthError | null }>;
  signIn: (email: string, password: string) => Promise<{ error: AuthError | null }>;
  signOut: () => Promise<void>;
  refreshUserAccount: (overrideUser?: User | null) => Promise<void>;
  freezeAuthCheck: (frozen: boolean) => void;
  isAuthCheckFrozen: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [userAccount, setUserAccount] = useState<UserAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [authCheckFrozen, setAuthCheckFrozen] = useState(false);
  const supabase = getSupabase();

  function freezeAuthCheck(frozen: boolean) {
    setAuthCheckFrozen(frozen);
  }

  async function refreshUserAccount(overrideUser?: User | null) {
    const currentUser = overrideUser !== undefined ? overrideUser : user;
    if (!currentUser) {
      setUserAccount(null);
      return;
    }

    try {
      // Add a timeout to prevent hanging the auth initialization
      const accountPromise = supabase
        .from('user_accounts')
        .select('*')
        .eq('id', currentUser.id)
        .single();
      
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Refresh account timeout')), 10000)
      );

      const { data, error } = await Promise.race([accountPromise, timeoutPromise]) as any;

      if (error) {
        if (error.code === 'PGRST116') { // Record not found
          const baseUsername = currentUser.email?.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 15) || 'user';
          const { data: newAccount, error: createError } = await supabase
            .from('user_accounts')
            .insert({
              id: currentUser.id,
              email: currentUser.email,
              username: baseUsername,
              approved: false,
              created_at: new Date().toISOString(),
            })
            .select()
            .single();

          if (createError) {
            console.error('Failed to create missing account:', createError);
            setUserAccount(null);
          } else {
            setUserAccount(newAccount);
          }
        } else {
          console.error('refreshUserAccount error:', error);
          setUserAccount(null);
        }
        return;
      }

      setUserAccount(data);
    } catch (err) {
      console.error('refreshUserAccount unexpected error or timeout:', err);
      // Don't reset userAccount to null on timeout/error - keep existing value
      // This prevents losing admin status due to network issues
    }
  }

  async function signUp(email: string, password: string, providedUsername?: string, realName?: string) {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: realName,
        },
      },
    });

     if (!error && data.user) {
       const baseUsername = providedUsername || email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 15);
       let username = baseUsername;
       
       try {
         // Create user account (unapproved)
         const { error: accountError } = await supabase
           .from('user_accounts')
           .insert({
             id: data.user.id,
             email,
             username,
             approved: false,
             created_at: new Date().toISOString(),
           });
 
         if (accountError) {
           console.error('Error creating user account:', accountError);
         }
         
         // Create approval request for admin
         const { error: approvalError } = await supabase
           .from('user_approvals')
           .insert({
             user_id: data.user.id,
             email: email.toLowerCase(),
             requested_at: new Date().toISOString(),
           });
           
         if (approvalError) {
           console.error('Error creating user approval:', approvalError);
         }
       } catch (err) {
         console.error('Error creating user account:', err);
       }
     }

    return { error };
  }

  async function signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    return { error };
  }

  async function signOut() {
    await supabase.auth.signOut();
    setUser(null);
    setSession(null);
    setUserAccount(null);
    if (typeof window !== 'undefined') localStorage.removeItem('nickname');
  }

  useEffect(() => {
    const initializeAuth = async () => {
      // Safety timeout for loading state - shorter for faster UX
      const safetyTimeout = setTimeout(() => {
        if (loading) {
          setLoading(false);
        }
      }, 10000);

      try {
        const { data: { session } } = await supabase.auth.getSession();
        setSession(session);
        const currentUser = session?.user ?? null;
        setUser(currentUser);

        if (currentUser) {
          await refreshUserAccount(currentUser);
        }
      } catch (error) {
        console.error('Auth initialization error:', error);
      } finally {
        clearTimeout(safetyTimeout);
        setLoading(false);
      }
    };

    initializeAuth();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      setSession(session);
      const currentUser = session?.user ?? null;
      setUser(currentUser);

      if (currentUser) {
        await refreshUserAccount(currentUser);
      } else {
        setUserAccount(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const value: AuthContextType = {
    user,
    session,
    userAccount,
    loading: loading || authCheckFrozen,
    signUp,
    signIn,
    signOut,
    refreshUserAccount,
    freezeAuthCheck,
    isAuthCheckFrozen: authCheckFrozen,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export { AuthContext };

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
