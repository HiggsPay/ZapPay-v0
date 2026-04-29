import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("❌ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}

// Service role client — bypasses RLS. Used for all server-side queries.
// Isolation is enforced in app layer by filtering on owner_id.
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
