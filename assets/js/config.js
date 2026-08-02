/**
 * ЕДИНСТВЕННЫЙ файл, который нужно заполнить перед запуском.
 * Возьмите значения в Supabase → Project Settings → API.
 */
window.PROMEBEL_CONFIG = {
  // Project Settings → API → Project URL
  SUPABASE_URL: "https://YOUR-PROJECT-REF.supabase.co",

  // Project Settings → API → Project API keys → anon public
  SUPABASE_ANON_KEY: "YOUR-ANON-PUBLIC-KEY",

  // Название Edge Function из папки supabase/functions (см. README)
  SUBMIT_REVIEW_FUNCTION: "submit-review",
};
