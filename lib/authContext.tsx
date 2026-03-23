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

interface AuthContextType {
  user: User | null;
  session: Session | null;
  userAccount: UserAccount | null;
  loading: boolean;
  signUp: (email: string, password: string, username: string, realName: string) => Promise<{ error: AuthError | null }>;
  signIn: (identifier: string, password: string) => Promise<{ error: AuthError | null }>;
  signOut: () => Promise<void>;
  refreshUserAccount: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [userAccount, setUserAccount] = useState<UserAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const supabase = getSupabase();

  async function refreshUserAccount() {
    if (!user) {
      setUserAccount(null);
      return;
    }

    try {
      const { data, error } = await supabase
        .from('user_accounts')
        .select('*')
        .eq('id', user.id)
        .single();

      // If there's no data and no error, or the error is specifically 'no rows found',
      // it means the account doesn't exist yet, so we should create it.
      const noRowsFound = error && error.code === 'PGRST116';
      if (!data && (!error || noRowsFound)) {
        console.warn('No user account found for user:', user.id, '- creating account from metadata.');
        
        const username = user.user_metadata.username;
        const realName = user.user_metadata.real_name;

        if (!username) {
            console.error("Critical: Cannot create user account, username is missing in auth metadata.", user);
            // Attempt to fall back to a generated username if metadata is missing
            const fallbackUsername = user.email!.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 15);
            console.warn("Falling back to generated username:", fallbackUsername);
            user.user_metadata.username = fallbackUsername;
        }

        try {
          // Check auto_approve setting
          const { data: settings } = await supabase
            .from('settings')
            .select('auto_approve')
            .eq('id', 1)
            .single();

          const autoApprove = settings?.auto_approve ?? false;

          // Create user account
          const { error: accountError } = await supabase
            .from('user_accounts')
            .insert({
              id: user.id,
              email: user.email!.toLowerCase(),
              username: user.user_metadata.username,
              real_name: user.user_metadata.real_name || null,
              approved: autoApprove,
            });

          if (accountError) {
            console.error('User account creation error during refresh:', accountError);
            setUserAccount(null);
            return;
          }

          // Create approval request if not auto approved
          if (!autoApprove) {
            const { error: approvalError } = await supabase
              .from('user_approvals')
              .insert({
                user_id: user.id,
                email: user.email!.toLowerCase(),
                username: user.user_metadata.username,
                real_name: user.user_metadata.real_name || null,
              });

            if (approvalError) {
              console.error('Approval creation error during refresh:', approvalError);
            }
          }

          // Now fetch the created account
          const { data: newData, error: fetchError } = await supabase
            .from('user_accounts')
            .select('*')
            .eq('id', user.id)
            .single();

          if (fetchError || !newData) {
            console.error('Error fetching newly created account:', fetchError);
            setUserAccount(null);
            return;
          }

          setUserAccount(newData);
        } catch (err) {
          console.error('Error creating user account in refresh flow:', err);
          setUserAccount(null);
        }
        return;
      }

      if (error) {
        console.error("Error fetching user account:", error);
      }
      
      setUserAccount(data ?? null);

    } catch (err) {
      console.error('Error in refreshUserAccount:', err);
      setUserAccount(null);
    }
  }

  async function signUp(email: string, password: string, username: string, realName: string) {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          username: username,
          real_name: realName,
        }
      }
    });

    // The rest of the logic is now handled by onAuthStateChange -> refreshUserAccount
    return { error };
  }

  async function signIn(identifier: string, password: string) {
    let email = identifier;

    // If the identifier doesn't look like an email, assume it's a username
    if (!identifier.includes('@')) {
      try {
        const response = await fetch('/api/get-email-by-username', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: identifier }),
        });

        const result = await response.json();

        if (!response.ok) {
          // Create an AuthError-like object to be consistent
          return { error: { name: "AuthApiError", message: result.error || 'User not found.' } as AuthError };
        }
        
        email = result.email;

      } catch (e) {
        console.error("API call to get email failed", e);
        return { error: { name: "AuthApiError", message: 'An unexpected error occurred.' } as AuthError };
      }
    }
    
    // Proceed with the email and password
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    return { error };
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  useEffect(() => {
    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    // Listen for auth changes
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      setSession(session);
      setUser(session?.user ?? null);

      if (session?.user) {
        await refreshUserAccount();
      } else {
        setUserAccount(null);
      }

      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  // Refresh user account when user changes
  useEffect(() => {
    if (user) {
      refreshUserAccount();
    }
  }, [user]);

  const value: AuthContextType = {
    user,
    session,
    userAccount,
    loading,
    signUp,
    signIn,
    signOut,
    refreshUserAccount,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}