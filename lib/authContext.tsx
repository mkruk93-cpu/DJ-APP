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
  signUp: (email: string, password: string, username?: string, realName?: string) => Promise<{ error: AuthError | null }>;
  signIn: (email: string, password: string) => Promise<{ error: AuthError | null }>;
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

      // Check if this is a "no rows found" error (different error formats from Supabase)
      const noRowsError = !!error && (
        (error.code && error.code === 'PGRST116') ||
        (typeof error.message === 'string' && /no rows/i.test(error.message)) ||
        (Object.keys(error).length === 0) // Empty error object = no rows
      );

      if (error && !noRowsError) {
        console.error('Error fetching user account:', {
          fullError: error,
          code: error.code,
          message: error.message,
          hint: error.hint,
          details: error.details,
        });
        setUserAccount(null);
        return;
      }

      // Handle no rows found - user doesn't have account yet
      if (noRowsError) {
        console.warn('No user account found for user:', user.id, '- user may need to complete setup or be approved');
        setUserAccount(null);
        return;
      }

      if (!data) {
        setUserAccount(null);
        return;
      }

      setUserAccount(data);
    } catch (err) {
      console.error('Error in refreshUserAccount:', err);
      setUserAccount(null);
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

    // If signup successful, create user account and approval request
    if (!error && data.user) {
      // Generate a username from email (remove domain, sanitize)
      const baseUsername = providedUsername || email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 15);
      let username = baseUsername;
      let counter = 1;
      
      // Ensure unique username
      let isUnique = false;
      while (!isUnique && counter < 50) {
        try {
          const { data: existing, error: checkError } = await supabase
            .from('user_accounts')
            .select('id')
            .eq('username', username)
            .single();
          
          if (checkError || !existing) {
            isUnique = true;
          } else {
            username = `${baseUsername}_${counter}`;
            counter++;
          }
        } catch {
          // If query fails, assume username is available
          isUnique = true;
        }
      }

      // Create user account
      try {
        const { error: accountError } = await supabase
          .from('user_accounts')
          .insert({
            id: data.user.id,
            email: email.toLowerCase(),
            username: username,
            approved: false,
          });

        if (accountError) {
          console.error('User account creation error:', {
            fullError: accountError,
            code: accountError?.code,
            message: accountError?.message,
            hint: accountError?.hint,
            details: accountError?.details,
          });
        }
      } catch (err) {
        console.error('User account creation exception:', err);
      }

      // Create approval request
      try {
        const { error: approvalError } = await supabase
          .from('user_approvals')
          .insert({
            user_id: data.user.id,
            email: email.toLowerCase(),
          });

        if (approvalError) {
          console.error('Approval creation error:', {
            fullError: approvalError,
            code: approvalError?.code,
            message: approvalError?.message,
            hint: approvalError?.hint,
            details: approvalError?.details,
          });
        }
      } catch (err) {
        console.error('Approval creation exception:', err);
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