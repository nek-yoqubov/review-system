// Требует, чтобы assets/js/config.js и CDN-скрипт supabase-js были подключены раньше.
window.supabaseClient = supabase.createClient(
  window.PROMEBEL_CONFIG.SUPABASE_URL,
  window.PROMEBEL_CONFIG.SUPABASE_ANON_KEY
);

window.EDGE_FUNCTION_URL = `${window.PROMEBEL_CONFIG.SUPABASE_URL}/functions/v1/${window.PROMEBEL_CONFIG.SUBMIT_REVIEW_FUNCTION}`;
