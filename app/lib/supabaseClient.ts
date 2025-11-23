// app/lib/supabaseClient.ts
import { createClient } from "@supabase/supabase-js";

// ✅ Use your actual Supabase project URL and anon key here
const SUPABASE_URL = "https://nmsgcmevnhhqnpqtjfic.supabase.co";
const SUPABASE_ANON_KEY =
  "sb_publishable_s6aMwUQyW7suHl9cI-1YhA_bAJpMJbJ";

if (!SUPABASE_URL) {
  throw new Error("SUPABASE_URL is missing");
}
if (!SUPABASE_ANON_KEY) {
  throw new Error("SUPABASE_ANON_KEY is missing");
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
