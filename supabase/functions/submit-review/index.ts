// Supabase Edge Function: submit-review
// Единственная точка записи в таблицу reviews.
// Deploy: supabase functions deploy submit-review --no-verify-jwt=false
//
// Требуемые Secrets (задаются автоматически Supabase, ничего делать не нужно):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://review.nekruz.xyz",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Эвристика "детектива": много 5★ без комментария за короткий срок на одного сотрудника
const FLAG_WINDOW_MINUTES = 60;
const FLAG_THRESHOLD = 3;

// Таджикистан живёт в UTC+5 круглый год (перехода на летнее время нет).
const TZ_OFFSET_HOURS = 5;

// Начало текущих суток по времени Таджикистана, в виде ISO-строки (UTC) для запроса к Postgres.
// Нужно, чтобы "уже оценивал сегодня" сбрасывалось ровно в полночь по Душанбе/Худжанду,
// а не через 24 часа от прошлого отзыва — иначе клиент, купивший вечером и вернувшийся
// рано утром на следующий день, не смог бы оставить второй отзыв.
function startOfLocalDayISO(): string {
  const now = new Date();
  const localMs = now.getTime() + TZ_OFFSET_HOURS * 60 * 60 * 1000;
  const local = new Date(localMs);
  local.setUTCHours(0, 0, 0, 0);
  const utcMs = local.getTime() - TZ_OFFSET_HOURS * 60 * 60 * 1000;
  return new Date(utcMs).toISOString();
}

// IP-адреса Wi-Fi шоурумов. Клиенты никогда не подключаются к сети магазина,
// поэтому отзыв, пришедший с одного из этих IP, гарантированно от сотрудника, а не от клиента.
// Задаётся через Supabase Secret STORE_IPS, например: "12.34.56.78,98.76.54.32"
// (список через запятую, без пробелов). Если secret не задан — проверка просто не применяется.
const STORE_IPS = (Deno.env.get("STORE_IPS") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return json({ code: "METHOD_NOT_ALLOWED", message: "Только POST" }, 405);
  }

  let body: { employee_slug?: string; rating?: number; comment?: string; client_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ code: "BAD_JSON", message: "Некорректное тело запроса" }, 400);
  }

  const employeeSlug = (body.employee_slug || "").trim();
  const rating = Number(body.rating);
  const comment = (body.comment || "").trim().slice(0, 500);
  // client_id — случайный UUID, сгенерированный один раз на устройстве и сохранённый в localStorage.
  // Нужен, чтобы разные клиенты за одним NAT/Wi-Fi шоурума (общий IP, часто похожий User-Agent)
  // не блокировали друг друга как "уже оценивал". Если клиент его не прислал (старая версия
  // страницы, приватный режим без localStorage) — используем пустую строку, деградация мягкая.
  const clientId = (body.client_id || "").trim().slice(0, 100);

  if (!employeeSlug) {
    return json({ code: "MISSING_SLUG", message: "Не указан сотрудник" }, 400);
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return json({ code: "BAD_RATING", message: "Оценка должна быть от 1 до 5" }, 400);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // 1. Находим активного сотрудника
  const { data: employee, error: empError } = await supabase
    .from("employees")
    .select("id, active")
    .eq("slug", employeeSlug)
    .maybeSingle();

  if (empError || !employee || !employee.active) {
    return json({ code: "EMPLOYEE_NOT_FOUND", message: "Сотрудник не найден или неактивен" }, 404);
  }

  // 2. Серверный анти-фрод: хэш IP+UA+client_id+employee_id, окно — текущие календарные сутки (UTC+5)
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    req.headers.get("cf-connecting-ip") ||
    "unknown";
  const userAgent = req.headers.get("user-agent") || "unknown";

  // Заявка с Wi-Fi шоурума — тихо отклоняем. Сообщение намеренно такое же,
  // как при обычном сбое сервера, чтобы не выдавать сотруднику, что именно
  // его вычислило (иначе он просто переключится на мобильный интернет).
  if (STORE_IPS.includes(ip)) {
    return json({ code: "SERVER_ERROR", message: "Не удалось сохранить отзыв, попробуйте позже" }, 500);
  }

  const deviceHash = await sha256Hex(`${ip}|${userAgent}|${clientId}|${employee.id}`);

  const sinceStartOfDay = startOfLocalDayISO();

  const { count: recentCount, error: dupError } = await supabase
    .from("reviews")
    .select("id", { count: "exact", head: true })
    .eq("employee_id", employee.id)
    .eq("device_hash", deviceHash)
    .gte("created_at", sinceStartOfDay);

  if (dupError) {
    return json({ code: "SERVER_ERROR", message: "Ошибка сервера, попробуйте позже" }, 500);
  }
  if ((recentCount || 0) > 0) {
    return json({ code: "ALREADY_REVIEWED", message: "Вы уже оценивали сегодня" }, 429);
  }

  // 3. Эвристика для флага "подозрительный" (для ручной проверки админом)
  const sinceFlagWindow = new Date(Date.now() - FLAG_WINDOW_MINUTES * 60 * 1000).toISOString();
  const { count: fiveStarNoCommentCount } = await supabase
    .from("reviews")
    .select("id", { count: "exact", head: true })
    .eq("employee_id", employee.id)
    .eq("rating", 5)
    .or("comment.is.null,comment.eq.")
    .gte("created_at", sinceFlagWindow);

  const isCurrentSuspicious = rating === 5 && comment.length === 0;
  const flagged = isCurrentSuspicious && (fiveStarNoCommentCount || 0) >= FLAG_THRESHOLD - 1;

  // 4. Запись отзыва
  const { error: insertError } = await supabase.from("reviews").insert({
    employee_id: employee.id,
    rating,
    comment: comment || null,
    device_hash: deviceHash,
    flagged,
  });

  if (insertError) {
    return json({ code: "INSERT_FAILED", message: "Не удалось сохранить отзыв" }, 500);
  }

  return json({ success: true });
});
