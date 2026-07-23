const { createClient } = require('@supabase/supabase-js')

// Supports either an anon key or a service-role key, whichever is configured.
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_KEY

if (!process.env.SUPABASE_URL || !supabaseKey) {
  console.log("⚠️ SUPABASE_URL or Supabase key env vars are missing — DB-backed features will fail.")
}

const supabase = createClient(process.env.SUPABASE_URL, supabaseKey)

module.exports = supabase
