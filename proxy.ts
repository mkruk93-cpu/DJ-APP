import { createClient } from '@/lib/supabase-server'
import { NextResponse, type NextRequest } from 'next/server'

export async function proxy(request: NextRequest) {
  const { supabase, response } = createClient(request)

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl

  const publicRoutes = ['/login', '/register', '/manifest', '/sw.js', '/icons']
  const authPages = ['/login', '/register']

  const isPublicRoute = publicRoutes.some((route) => pathname.startsWith(route))

  if (!user && !isPublicRoute) {
    const redirectUrl = new URL('/login', request.url)
    redirectUrl.searchParams.set('redirect', pathname)
    return NextResponse.redirect(redirectUrl)
  }

  if (!user) {
    return response
  }

  const { data: userAccount } = await supabase
    .from('user_accounts')
    .select('approved')
    .eq('id', user.id)
    .maybeSingle()

  const isApproved = userAccount?.approved === true
  const isAuthPage = authPages.some((route) => pathname.startsWith(route))

  if (!isApproved && !isAuthPage) {
    const redirectUrl = new URL('/login', request.url)
    redirectUrl.searchParams.set('pending', '1')
    redirectUrl.searchParams.set('redirect', pathname)
    return NextResponse.redirect(redirectUrl)
  }

  if (isApproved && isAuthPage) {
    return NextResponse.redirect(new URL('/stream', request.url))
  }

  return response
}

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|sw.js|icons).*)',
  ],
}
