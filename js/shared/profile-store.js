// ==================== USER PROFILE STORE ====================
// One reader and one writer for `user_profile`, shared by every screen that
// edits it. Four screens each had their own copy of this, and each of them
// swallowed whatever the database said and printed "Please try again."
//
// Two things were wrong with that.
//
// The first is that upsert(..., { onConflict: 'user_id' }) needs a unique
// constraint on user_id. Without one Postgres returns 42P10 — "there is no
// unique or exclusion constraint matching the ON CONFLICT specification" — and
// every profile save on the platform fails, for every customer, permanently.
// The constraint belongs in the schema (see docs/supabase-setup.md), but a
// bank should not stop saving addresses because of one missing index, so this
// falls back to update-then-insert, which needs no constraint at all.
//
// The second is that "Please try again" is not a message, it is a shrug.
// Trying again does not add a missing column. describeWriteError() turns the
// database's answer into something that says what actually has to be fixed.

export async function readProfile({ supabaseClient, getCurrentUser }) {
  const user = await getCurrentUser();
  if (!user) return null;
  if (!supabaseClient) return { user_id: user.id };

  try {
    const { data, error } = await supabaseClient
      .from('user_profile')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();
    if (error) throw error;
    return data || { user_id: user.id };
  } catch (err) {
    console.error('Profile read error:', err);
    return { user_id: user.id };
  }
}

/**
 * Write a patch to this user's profile row. Resolves on success and throws an
 * Error whose message is fit to show a customer.
 */
export async function writeProfile(ctx, patch) {
  const { supabaseClient, getCurrentUser } = ctx;
  const user = await getCurrentUser();
  if (!user) throw new Error('You are signed out. Sign in again and retry.');
  if (!supabaseClient) throw new Error('You appear to be offline. Reconnect and try again.');

  const row = { user_id: user.id, ...patch };

  // The happy path, and the only one that runs once the schema is right.
  const upsert = await supabaseClient
    .from('user_profile')
    .upsert(row, { onConflict: 'user_id' });

  if (!upsert.error) {
    afterWrite(ctx, patch);
    return;
  }

  // 42P10 is the missing-unique-constraint case specifically. Anything else —
  // a missing column, a policy refusal — is a real failure and is reported as
  // one rather than papered over by a second attempt that would fail too.
  if (upsert.error.code !== '42P10') {
    console.error('Profile upsert error:', upsert.error);
    throw new Error(describeWriteError(upsert.error));
  }

  console.warn('user_profile has no unique constraint on user_id — falling back to update/insert. See docs/supabase-setup.md.');

  // Update first: the row usually exists, and this touches nothing when it
  // does not. `select()` is what tells the two apart without a second read.
  const update = await supabaseClient
    .from('user_profile')
    .update(patch)
    .eq('user_id', user.id)
    .select('user_id');

  if (update.error) {
    console.error('Profile update error:', update.error);
    throw new Error(describeWriteError(update.error));
  }
  if (update.data && update.data.length) {
    afterWrite(ctx, patch);
    return;
  }

  const insert = await supabaseClient.from('user_profile').insert(row);
  if (insert.error) {
    console.error('Profile insert error:', insert.error);
    throw new Error(describeWriteError(insert.error));
  }
  afterWrite(ctx, patch);
}

// The audit trail records which fields changed, never their values — an
// address in an event log is an address in one more place than it needs to be.
function afterWrite(ctx, patch) {
  if (ctx.recordEvent) ctx.recordEvent('profile.updated', { fields: Object.keys(patch) });
}

/**
 * What went wrong, in words that point at the fix. The codes are Postgres's:
 * they are the difference between "the network hiccuped" and "this column does
 * not exist", and a customer staring at "please try again" can tell neither.
 */
export function describeWriteError(error) {
  const code = error && error.code;
  const message = (error && error.message) || '';

  // Column missing from the table.
  if (code === '42703' || /column .* does not exist/i.test(message)) {
    return 'This field is not set up on the account record yet. Contact support — they can add it.';
  }
  // Row Level Security refused the write.
  if (code === '42501' || /row-level security/i.test(message)) {
    return 'You do not have permission to change this. Contact support if that seems wrong.';
  }
  // No unique constraint for the ON CONFLICT target.
  if (code === '42P10') {
    return 'The account record could not be saved because of a configuration problem on our side. Contact support.';
  }
  // Table missing entirely.
  if (code === '42P01') {
    return 'The account record is unavailable right now. Contact support.';
  }
  if (/fetch|network|failed to fetch/i.test(message)) {
    return 'We could not reach the bank. Check your connection and try again.';
  }
  return message || 'That change could not be saved. Please try again.';
}
