-- ============================================================
-- Pro Mebel · Система сбора отзывов по QR
-- Схема Supabase (Postgres). Выполните этот файл целиком
-- в Supabase Dashboard → SQL Editor.
-- ============================================================

-- ---------- Расширения ----------
create extension if not exists pgcrypto;

-- ---------- Таблица: сотрудники ----------
create table if not exists employees (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  full_name text not null,
  role text not null check (role in ('manager', 'consultant', 'other')),
  branch text not null check (branch in ('khujand', 'dushanbe')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------- Таблица: отзывы ----------
create table if not exists reviews (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id) on delete cascade,
  rating int not null check (rating between 1 and 5),
  comment text,
  device_hash text not null,       -- хэш IP+UA+employee_id, серверный, клиенту не отдаётся
  flagged boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_reviews_employee on reviews(employee_id);
create index if not exists idx_reviews_device_hash_time on reviews(device_hash, employee_id, created_at);
create index if not exists idx_reviews_flagged on reviews(flagged) where flagged = true;

-- ---------- Роли админки ----------
-- Связывает пользователя Supabase Auth с ролью в системе.
-- Добавляйте админов через SQL Editor:
--   insert into staff_users (user_id, role) values ('<uuid из auth.users>', 'admin');
create table if not exists staff_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin', 'viewer')),
  created_at timestamptz not null default now()
);

create or replace function is_staff()
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from staff_users where user_id = auth.uid()
  );
$$;

create or replace function is_admin()
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from staff_users where user_id = auth.uid() and role = 'admin'
  );
$$;

-- ============================================================
-- RLS
-- ============================================================
alter table employees enable row level security;
alter table reviews enable row level security;
alter table staff_users enable row level security;

-- employees: анонимный клиент видит только активных сотрудников
-- (нужно для страниц /review и /select)
drop policy if exists "public can read active employees" on employees;
create policy "public can read active employees"
  on employees for select
  to anon
  using (active = true);

-- employees: сотрудники staff (admin/viewer) видят всех
drop policy if exists "staff can read all employees" on employees;
create policy "staff can read all employees"
  on employees for select
  to authenticated
  using (is_staff());

-- employees: изменять могут только admin
drop policy if exists "admin can insert employees" on employees;
create policy "admin can insert employees"
  on employees for insert
  to authenticated
  with check (is_admin());

drop policy if exists "admin can update employees" on employees;
create policy "admin can update employees"
  on employees for update
  to authenticated
  using (is_admin())
  with check (is_admin());

-- Намеренно НЕТ политики delete — сотрудников не удаляют физически,
-- только деактивируют (active = false), чтобы сохранить историю отзывов.

-- reviews: anon вообще не имеет доступа напрямую.
-- INSERT происходит только через Edge Function с service role
-- (service role обходит RLS, поэтому отдельная policy для anon insert не нужна и не создаётся).

-- reviews: читают только staff
drop policy if exists "staff can read reviews" on reviews;
create policy "staff can read reviews"
  on reviews for select
  to authenticated
  using (is_staff());

-- staff_users: пользователь может прочитать только свою запись
-- (нужно фронтенду админки, чтобы понять роль после логина)
drop policy if exists "self can read own staff row" on staff_users;
create policy "self can read own staff row"
  on staff_users for select
  to authenticated
  using (user_id = auth.uid());

-- ============================================================
-- Вьюха для админки: сотрудник + агрегаты по отзывам
-- ============================================================
create or replace view employee_stats as
select
  e.id,
  e.slug,
  e.full_name,
  e.role,
  e.branch,
  e.active,
  count(r.id) as reviews_count,
  coalesce(round(avg(r.rating)::numeric, 2), 0) as avg_rating,
  count(r.id) filter (where r.flagged) as flagged_count
from employees e
left join reviews r on r.employee_id = e.id
group by e.id;

alter view employee_stats set (security_invoker = true);
-- security_invoker гарантирует, что вьюха уважает RLS таблиц reviews/employees
-- (видна только staff, т.к. reviews закрыты для anon).
