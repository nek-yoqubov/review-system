# Pro Mebel · Система сбора отзывов по QR-коду

Реализация ТЗ: клиент сканирует QR у консультанта → ставит оценку 1–5 и
пишет комментарий → данные летят в Supabase с трёхслойной анти-фрод
защитой → закрытая админ-панель показывает статистику.

## Структура репозитория

```
index.html          — заглушка на корне (для прямых заходов без QR)
review.html + .js    — публичная страница отзыва  /review.html?m={slug}
select.html + .js    — выбор сотрудника для общего QR филиала /select.html?branch=khujand
admin/                — закрытая админ-панель (сотрудники, отзывы, аналитика)
assets/               — общие стили, конфиг, illustration-слоты
supabase/schema.sql   — таблицы, роли, RLS-политики (выполнить в SQL Editor)
supabase/functions/submit-review — Edge Function, единственная точка записи отзыва
.github/workflows/deploy.yml — автодеплой на GitHub Pages при пуше в main
CNAME                 — review.nekruz.xyz
```

## Разворачивание — по шагам

### 1. Supabase

1. Создайте проект на supabase.com.
2. SQL Editor → вставьте и выполните целиком `supabase/schema.sql`.
3. Deploy Edge Function:
   ```bash
   supabase login
   supabase link --project-ref <ваш-project-ref>
   supabase functions deploy submit-review
   ```
4. Создайте первого администратора:
   - Authentication → Users → Add user (email + пароль).
   - Скопируйте его `UID`.
   - SQL Editor:
     ```sql
     insert into staff_users (user_id, role) values ('<UID>', 'admin');
     ```

### 2. Конфиг сайта

Откройте `assets/js/config.js` и вставьте:
- `SUPABASE_URL` и `SUPABASE_ANON_KEY` — из Project Settings → API.

Больше редактировать код не нужно.

### 3. GitHub Pages

1. Запушьте репозиторий в GitHub, ветка `main`.
2. Settings → Pages → Source: **GitHub Actions** (workflow уже в репозитории).
3. Settings → Pages → Custom domain: `review.nekruz.xyz` (файл `CNAME` уже есть),
   в DNS добавьте CNAME-запись `review` → `<ваш-логин>.github.io`.
4. После первого пуша в `main` сайт задеплоится автоматически.

### 4. Добавление сотрудников и QR

Зайдите на `https://review.nekruz.xyz/admin/`, войдите под администратором,
добавьте сотрудников — slug и ссылка сгенерируются автоматически, кнопка
**QR** в таблице даёт PNG для печати/размещения на стойке.

Если QR общий на филиал — ведите на
`https://review.nekruz.xyz/select.html?branch=khujand`
(клиент сам выберет сотрудника из списка).

## Анти-фрод — как это работает

| Слой | Где | Что делает |
|---|---|---|
| 1. Клиентский | `review.js`, localStorage | Прячет форму повторно в этот день на этом устройстве/браузере |
| 2. Серверный | Edge Function `submit-review` | Хэширует IP+User-Agent+employee_id, блокирует повтор на 24 часа. `reviews` закрыта RLS от anon — запись идёт только через service role внутри функции |
| 3. Детектив | Edge Function + админка | Флагает отзыв, если подряд идёт ≥3 пятёрок без комментария на одного сотрудника за 60 минут; в разделе «Отзывы» такие подсвечиваются |

Это не банковский уровень защиты (SMS-верификация и геолокация сознательно
не реализованы — см. ТЗ, п. 9), но обходится не проще, чем очисткой кэша
+ смена IP одновременно.

## Про анимации (Storyset)

По вашей просьбе иллюстрации с storyset.com **не встроены напрямую** —
вместо них в `review.html` оставлены помеченные слоты:

```html
<div class="illustration-slot" data-note="storyset.com: анимация ... — вставьте сюда">
  ...
</div>
```

Их три — экран «Спасибо», экран «Уже оценивали сегодня», экран «Нет
доступа». Внутри уже лежит лёгкая запасная CSS/SVG-анимация (галочка и
иконка замка), чтобы страница не выглядела пустой до того, как вы
вставите свою. Чтобы добавить Storyset:

1. Скачайте SVG или Lottie-анимацию нужной сцены с storyset.com.
2. Замените содержимое соответствующего `.illustration-slot` в `review.html`
   на `<img src="assets/illustrations/thank-you.svg" ...>` (файл предварительно
   положите в `assets/illustrations/`).

## Локальная проверка без деплоя

Просто откройте `review.html?m=<slug-существующего-сотрудника>` через любой
локальный статический сервер (например `npx serve .`) — прямое открытие
файла через `file://` не сработает из-за CORS для fetch-запросов к Supabase.
