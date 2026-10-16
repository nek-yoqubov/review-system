import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://review.nekruz.xyz",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

const SALT = Deno.env.get("REVIEW_SALT") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

async function hmacHex(input: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SALT), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const TZ_OFFSET_HOURS = 5;
const PER_IP_PER_EMPLOYEE_PER_DAY = 3;
const PER_IP_PER_HOUR = 10;
const BURST_WINDOW_MINUTES = 60;
const BURST_THRESHOLD = 3;

function startOfLocalDayISO(): string {
  const local = new Date(Date.now() + TZ_OFFSET_HOURS * 3600 * 1000);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - TZ_OFFSET_HOURS * 3600 * 1000).toISOString();
}

const STORE_IPS = (Deno.env.get("STORE_IPS") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function ipCandidates(req: Request): string[] {
  const xff = (req.headers.get("x-forwarded-for") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const list = [req.headers.get("cf-connecting-ip"), req.headers.get("x-real-ip"), ...xff]
    .map((s) => (s || "").trim())
    .filter(Boolean);
  return [...new Set(list)];
}

function primaryIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const real = req.headers.get("x-real-ip");
  if (real) return real.trim();
  const xff = (req.headers.get("x-forwarded-for") || "").split(",").map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : "unknown";
}

const genericError = () => json({ code: "SERVER_ERROR", message: "Не удалось сохранить отзыв, попробуйте позже" }, 500);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  if (req.method === "GET" && new URL(req.url).searchParams.has("myip")) {
    return json({ ip: primaryIp(req), all: ipCandidates(req) });
  }

  if (req.method !== "POST") return json({ code: "METHOD_NOT_ALLOWED", message: "Только POST" }, 405);

  let body: { employee_slug?: string; rating?: number; comment?: string; client_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ code: "BAD_JSON", message: "Некорректное тело запроса" }, 400);
  }

  const employeeSlug = String(body.employee_slug || "").trim().slice(0, 100);
  const rating = Number(body.rating);
  const comment = String(body.comment || "").trim().slice(0, 500);
  const clientId = String(body.client_id || "").trim().slice(0, 100);

  if (!employeeSlug) return json({ code: "MISSING_SLUG", message: "Не указан сотрудник" }, 400);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return json({ code: "BAD_RATING", message: "Оценка должна быть от 1 до 5" }, 400);
  }

  const candidates = ipCandidates(req);
  if (candidates.some((ip) => STORE_IPS.includes(ip))) return genericError();

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { db: { schema: "review" } },
  );

  const { data: employee, error: empError } = await supabase
    .from("employees")
    .select("id, active")
    .eq("slug", employeeSlug)
    .maybeSingle();

  if (empError || !employee || !employee.active) {
    return json({ code: "EMPLOYEE_NOT_FOUND", message: "Сотрудник не найден или неактивен" }, 404);
  }

  const ip = primaryIp(req);
  const userAgent = req.headers.get("user-agent") || "unknown";
  const ipHash = await hmacHex(`ip|${ip}`);
  const deviceHash = await hmacHex(`dev|${ip}|${userAgent}|${clientId}|${employee.id}`);
  const dayStart = startOfLocalDayISO();
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  const burstSince = new Date(Date.now() - BURST_WINDOW_MINUTES * 60 * 1000).toISOString();

  const count = async (q: any) => {
    const { count, error } = await q;
    if (error) throw error;
    return count || 0;
  };
  const base = () => supabase.from("reviews").select("id", { count: "exact", head: true });

  let sameDevice = 0, sameIpEmployeeToday = 0, sameIpHour = 0, employeeBurst = 0, fiveNoComment = 0;
  try {
    [sameDevice, sameIpEmployeeToday, sameIpHour, employeeBurst, fiveNoComment] = await Promise.all([
      count(base().eq("employee_id", employee.id).eq("device_hash", deviceHash).gte("created_at", dayStart)),
      count(base().eq("employee_id", employee.id).eq("ip_hash", ipHash).gte("created_at", dayStart)),
      count(base().eq("ip_hash", ipHash).gte("created_at", hourAgo)),
      count(base().eq("employee_id", employee.id).gte("created_at", burstSince)),
      count(base().eq("employee_id", employee.id).eq("rating", 5).or("comment.is.null,comment.eq.").gte("created_at", burstSince)),
    ]);
  } catch {
    return json({ code: "SERVER_ERROR", message: "Ошибка сервера, попробуйте позже" }, 500);
  }

  if (sameDevice > 0 || sameIpEmployeeToday >= PER_IP_PER_EMPLOYEE_PER_DAY) {
    return json({ code: "ALREADY_REVIEWED", message: "Вы уже оценивали сегодня" }, 429);
  }
  if (sameIpHour >= PER_IP_PER_HOUR) return genericError();

  const flagged =
    sameIpEmployeeToday > 0 ||
    employeeBurst >= BURST_THRESHOLD - 1 ||
    (rating === 5 && comment.length === 0 && fiveNoComment >= BURST_THRESHOLD - 1);

  const { error: insertError } = await supabase.from("reviews").insert({
    employee_id: employee.id,
    rating,
    comment: comment || null,
    device_hash: deviceHash,
    ip_hash: ipHash,
    flagged,
  });

  if (insertError) return json({ code: "INSERT_FAILED", message: "Не удалось сохранить отзыв" }, 500);
  return json({ success: true });
});
