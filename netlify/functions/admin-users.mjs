// Server function for the two things that need the Supabase secret key:
// creating a login and resetting a password. Only an active admin may call it.
// The secret key lives in the Netlify environment variable SUPABASE_SERVICE_KEY
// and never reaches the browser.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://nbfdzrdjtevpjcddumiw.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const asService = (extra) => ({
  apikey: SERVICE_KEY,
  Authorization: 'Bearer ' + SERVICE_KEY,
  'Content-Type': 'application/json',
  ...extra,
});

async function readError(res) {
  try {
    const b = await res.json();
    return b.msg || b.message || b.error_description || b.error || JSON.stringify(b);
  } catch (e) {
    return 'HTTP ' + res.status;
  }
}

async function writeLog(row) {
  await fetch(SUPABASE_URL + '/rest/v1/audit_log', {
    method: 'POST', headers: asService({ Prefer: 'return=minimal' }), body: JSON.stringify(row),
  });
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Use POST' });
  if (!SERVICE_KEY) {
    return json(500, { error: 'SUPABASE_SERVICE_KEY is not set in Netlify. Add it under Site configuration, Environment variables, then redeploy.' });
  }

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'Sign in first' });

  // Who is calling?
  const who = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + token },
  });
  if (!who.ok) return json(401, { error: 'Your session has expired. Sign in again.' });
  const caller = await who.json();

  // Are they an active admin?
  const prof = await fetch(
    SUPABASE_URL + '/rest/v1/profiles?select=role,active&id=eq.' + encodeURIComponent(caller.id),
    { headers: asService() });
  if (!prof.ok) return json(500, { error: 'Could not check your account: ' + (await readError(prof)) });
  const rows = await prof.json();
  if (!rows.length || !rows[0].active || rows[0].role !== 'admin') {
    return json(403, { error: 'Only an admin can do this' });
  }

  let body;
  try { body = await req.json(); } catch (e) { return json(400, { error: 'Bad request' }); }

  if (body.action === 'create') {
    const full_name = String(body.full_name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const role = body.role;
    if (!full_name) return json(400, { error: 'Enter the full name' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return json(400, { error: 'Enter a valid email' });
    if (password.length < 8) return json(400, { error: 'The password needs at least 8 characters' });
    if (role !== 'admin' && role !== 'staff') return json(400, { error: 'Role must be admin or staff' });

    const made = await fetch(SUPABASE_URL + '/auth/v1/admin/users', {
      method: 'POST', headers: asService(),
      body: JSON.stringify({ email, password, email_confirm: true }),
    });
    if (!made.ok) return json(400, { error: 'Could not create the login: ' + (await readError(made)) });
    const user = await made.json();

    const ins = await fetch(SUPABASE_URL + '/rest/v1/profiles', {
      method: 'POST', headers: asService({ Prefer: 'return=minimal' }),
      body: JSON.stringify({ id: user.id, full_name, email, role, created_by: caller.id }),
    });
    if (!ins.ok) {
      const why = await readError(ins);
      await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + user.id, { method: 'DELETE', headers: asService() });
      return json(500, { error: 'Could not save the account: ' + why });
    }
    await writeLog({
      account_id: caller.id, action: 'account_create', entity: 'account', entity_id: user.id,
      new_value: { full_name, email, role },
    });
    return json(200, { ok: true, id: user.id });
  }

  if (body.action === 'reset_password') {
    const user_id = String(body.user_id || '');
    const password = String(body.password || '');
    if (!/^[0-9a-f-]{36}$/i.test(user_id)) return json(400, { error: 'Unknown account' });
    if (password.length < 8) return json(400, { error: 'The password needs at least 8 characters' });
    const put = await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + user_id, {
      method: 'PUT', headers: asService(), body: JSON.stringify({ password }),
    });
    if (!put.ok) return json(400, { error: 'Could not change the password: ' + (await readError(put)) });
    await writeLog({ account_id: caller.id, action: 'password_reset', entity: 'account', entity_id: user_id });
    return json(200, { ok: true });
  }

  return json(400, { error: 'Unknown action' });
};
