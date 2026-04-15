/**
 * POST /api/onboarding/company — create the tenant for a founding owner.
 *
 * Purpose:  Transactionally provisions a brand-new LMBR.ai tenant: inserts
 *           the companies row, creates the matching public.users row for
 *           the authenticated signup, and assigns them the 'owner' role.
 *           Runs under the service role because the caller has a session
 *           but no public.users row yet — current_company_id() returns null
 *           and every RLS policy on public.companies would reject them.
 *
 *           Session validation is explicit (not RLS-derived): we read the
 *           signed-in user via the cookie-backed SSR client, then only use
 *           the service-role client for writes scoped to that user.id.
 *
 * Input:    { companyName, companySlug, emailDomain, bidsPrefix, fullName? }
 * Output:   { company_id, slug }
 * Imports:  @lmbr/lib (getSupabaseAdmin), lib/supabase/server, zod, next.
 *
 * LMBR.ai — Enterprise AI bid automation for wholesale lumber distributors.
 * Built by Worklighter.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getSupabaseAdmin } from '@lmbr/lib';
import { getSupabaseRouteHandlerClient } from '../../../../lib/supabase/server';
import { slugify } from '../../../../lib/slugify';

export const runtime = 'nodejs';

const BodySchema = z.object({
  companyName: z.string().trim().min(2).max(120),
  companySlug: z
    .string()
    .trim()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9-]+$/, 'Slug can only contain lowercase letters, numbers, and hyphens'),
  emailDomain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'Enter a valid domain like cascadelumber.com')
    .optional(),
  bidsPrefix: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9._-]+$/, 'Prefix can only contain letters, numbers, dots, dashes, underscores')
    .default('bids'),
  fullName: z.string().trim().min(2).max(120).optional(),
});

export async function POST(req: Request) {
  const sessionClient = getSupabaseRouteHandlerClient();
  const {
    data: { session },
    error: sessionError,
  } = await sessionClient.auth.getSession();

  if (sessionError) {
    return NextResponse.json({ error: sessionError.message }, { status: 401 });
  }
  if (!session) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  // If the user already has a public.users row, they already completed the
  // company step — don't let them double-create.
  const { data: existingUser } = await sessionClient
    .from('users')
    .select('id, company_id')
    .eq('id', session.user.id)
    .maybeSingle();

  if (existingUser) {
    return NextResponse.json(
      {
        error: 'This account is already attached to a company.',
        company_id: existingUser.company_id,
      },
      { status: 409 },
    );
  }

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await req.json());
  } catch (err) {
    const message = err instanceof z.ZodError ? err.errors[0]?.message ?? 'Invalid input' : 'Invalid JSON';
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const normalizedSlug = slugify(body.companySlug);
  if (normalizedSlug.length < 2) {
    return NextResponse.json({ error: 'Company slug is too short' }, { status: 400 });
  }

  const admin = getSupabaseAdmin();

  // Uniqueness check on slug — returns a friendly error instead of a raw
  // Postgres unique-violation from the insert below.
  const { data: slugCollision } = await admin
    .from('companies')
    .select('id')
    .eq('slug', normalizedSlug)
    .maybeSingle();

  if (slugCollision) {
    return NextResponse.json(
      { error: `The slug "${normalizedSlug}" is already taken. Pick another.` },
      { status: 409 },
    );
  }

  const { data: company, error: companyError } = await admin
    .from('companies')
    .insert({
      name: body.companyName,
      slug: normalizedSlug,
      email_domain: body.emailDomain ?? null,
      plan: 'starter',
      active: true,
    })
    .select('id, slug')
    .single();

  if (companyError || !company) {
    return NextResponse.json(
      { error: companyError?.message ?? 'Failed to create company' },
      { status: 500 },
    );
  }

  const fullName =
    body.fullName ??
    (session.user.user_metadata?.full_name as string | undefined) ??
    session.user.email?.split('@')[0] ??
    'Owner';

  const { error: userInsertError } = await admin.from('users').insert({
    id: session.user.id,
    company_id: company.id,
    email: session.user.email!,
    full_name: fullName,
  });

  if (userInsertError) {
    // Roll back the company we just created so the tenant doesn't dangle.
    await admin.from('companies').delete().eq('id', company.id);
    return NextResponse.json({ error: userInsertError.message }, { status: 500 });
  }

  const { error: roleInsertError } = await admin.from('roles').insert({
    user_id: session.user.id,
    company_id: company.id,
    role_type: 'owner',
  });

  if (roleInsertError) {
    await admin.from('users').delete().eq('id', session.user.id);
    await admin.from('companies').delete().eq('id', company.id);
    return NextResponse.json({ error: roleInsertError.message }, { status: 500 });
  }

  // bidsPrefix is not persisted yet — schema migration for the
  // bids-inbox prefix lives in the Outlook integration prompt (PROMPT 08).
  // We accept it now so the onboarding UX is forward-compatible but
  // simply log it for that integration to pick up later.
  //
  // TODO(PROMPT 08): persist bidsPrefix on public.companies.

  return NextResponse.json(
    { company_id: company.id, slug: company.slug },
    { status: 201 },
  );
}
