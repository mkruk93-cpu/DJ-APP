type AdminUserLike = {
  approved?: boolean | null;
  username?: string | null;
  email?: string | null;
};

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

export function isConfiguredAdminUser(user: AdminUserLike | null | undefined): boolean {
  if (!user?.approved) return false;

  const username = normalize(user.username);
  const email = normalize(user.email);
  const configuredUsername = normalize(process.env.NEXT_PUBLIC_ADMIN_USERNAME ?? process.env.NEXT_PUBLIC_TWITCH_CHANNEL);
  const configuredEmail = normalize(process.env.NEXT_PUBLIC_ADMIN_EMAIL);

  if (configuredEmail && email === configuredEmail) return true;
  if (configuredUsername && username === configuredUsername) return true;

  return false;
}
