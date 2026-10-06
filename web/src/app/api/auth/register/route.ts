import { NextResponse } from 'next/server';

/**
 * Registration is intentionally a stub at this stage of the skeleton.
 *
 * The auth store is keyed by email + password and the first user seeded from
 * the environment is an admin. Once the registration flow is wired, this route
 * will create the user, issue a session cookie, and return the same shape as
 * login. Until then, returning 501 keeps the UI honest: the form exists, the
 * endpoint exists, the logic does not yet.
 */
export async function POST() {
  return NextResponse.json(
    { error: { code: 'not_implemented', detail: 'Registration is not wired yet.' } },
    { status: 501 },
  );
}