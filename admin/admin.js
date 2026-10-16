(function () {
  const sb = window.supabaseClient;
  const ROLE_LABELS = { manager: "Менеджер", consultant: "Консультант", other: "Другое" };
  const BRANCH_LABELS = { khujand: "Худжанд", dushanbe: "Душанбе" };

  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------
  // Транслитерация для генерации slug из имени
  // ---------------------------------------------------------
  const TRANSLIT = {
    а:"a",б:"b",в:"v",г:"g",д:"d",е:"e",ё:"e",ж:"zh",з:"z",и:"i",й:"y",
    к:"k",л:"l",м:"m",н:"n",о:"o",п:"p",р:"r",с:"s",т:"t",у:"u",ф:"f",
    х:"h",ц:"ts",ч:"ch",ш:"sh",щ:"sch",ъ:"",ы:"y",ь:"",э:"e",ю:"yu",я:"ya",
    қ:"q",ғ:"g",ӯ:"u",ҳ:"h",ҷ:"j",
  };
  function slugify(name) {
    const base = name
      .toLowerCase()
      .split("")
      .map((ch) => (TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : ch))
      .join("")
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-");
    const rand = Math.random().toString(36).slice(2, 6);
    return `${base}-${rand}`;
  }

  function initials(name) {
    return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join("").toUpperCase();
  }

  // ---------------------------------------------------------
  // Авторизация
  // ---------------------------------------------------------
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let currentRole = null; // 'admin' | 'viewer'

  async function tryEnterApp() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return showLogin();

    const { data: staffRow } = await sb
      .from("staff_users")
      .select("role")
      .eq("user_id", session.user.id)
      .maybeSingle();

    if (!staffRow) {
      $("login-error").textContent = "У вашего аккаунта нет доступа к админ-панели.";
      $("login-error").classList.add("show");
      await sb.auth.signOut();
      return showLogin();
    }

    currentRole = staffRow.role;
    applyRolePermissions();
    showApp();
  }

  // viewer видит те же данные, но не может создавать/менять сотрудников —
  // RLS всё равно это отклонит на уровне базы, но кнопки скрываем заранее,
  // чтобы не было немой ошибки при клике.
  function applyRolePermissions() {
    const isAdmin = currentRole === "admin";
    $("add-employee-btn").style.display = isAdmin ? "" : "none";
    document.body.classList.toggle("role-viewer", !isAdmin);
  }

  function showLogin() {
    $("login-screen").style.display = "";
    $("app-screen").style.display = "none";
  }
  function showApp() {
    $("login-screen").style.display = "none";
    $("app-screen").style.display = "";
    loadEmployees();
  }

  $("login-btn").addEventListener("click", async () => {
    $("login-error").classList.remove("show");
    const email = $("login-email").value.trim();
    const password = $("login-password").value;
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      $("login-error").textContent = "Неверный email или пароль.";
      $("login-error").classList.add("show");
      return;
    }
    tryEnterApp();
  });

  $("logout-btn").addEventListener("click", async () => {
    await sb.auth.signOut();
    showLogin();
  });

  // ---------------------------------------------------------
  // Вкладки
  // ---------------------------------------------------------
  document.querySelectorAll(".admin-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".admin-tab").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      document.querySelectorAll(".admin-tab-panel").forEach((p) => (p.style.display = "none"));
      $(`tab-${btn.dataset.tab}`).style.display = "";
      if (btn.dataset.tab === "reviews") loadReviews();
      if (btn.dataset.tab === "analytics") loadAnalytics();
    });
  });

  // ---------------------------------------------------------
  // Сотрудники
  // ---------------------------------------------------------
  let employeesCache = [];

  async function loadEmployees() {
    const { data, error } = await sb
      .from("employee_stats")
      .select("*")
      .order("full_name", { ascending: true });

    const tbody = $("employees-tbody");
    if (error || !data) {
      tbody.innerHTML = `<tr><td colspan="7" class="hint">Не удалось загрузить список.</td></tr>`;
      return;
    }
    employeesCache = data;
    renderEmployeesTable(data);
    fillEmployeeFilter(data);
  }

  function renderEmployeesTable(rows) {
    const tbody = $("employees-tbody");
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="hint">Пока нет сотрудников — добавьте первого.</td></tr>`;
      return;
    }
    tbody.innerHTML = "";
    rows.forEach((emp) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${esc(emp.full_name)}</td>
        <td>${esc(ROLE_LABELS[emp.role] || emp.role)}</td>
        <td>${esc(BRANCH_LABELS[emp.branch] || emp.branch)}</td>
        <td>${emp.reviews_count > 0 ? emp.avg_rating : "—"}</td>
        <td>${emp.reviews_count}${emp.flagged_count > 0 ? ` <span class="badge badge--flag">${emp.flagged_count} флаг</span>` : ""}</td>
        <td><span class="badge ${emp.active ? "badge--active" : "badge--inactive"}">${emp.active ? "Активен" : "Уволен"}</span></td>
        <td>
          <div class="row-actions">
            <button data-action="qr" data-slug="${esc(emp.slug)}" data-name="${esc(emp.full_name)}">QR</button>
            <button data-action="edit" data-id="${esc(emp.id)}">✎</button>
            <button data-action="toggle" data-id="${esc(emp.id)}" data-active="${emp.active}">${emp.active ? "Деактивировать" : "Восстановить"}</button>
          </div>
        </td>`;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('button[data-action="qr"]').forEach((b) =>
      b.addEventListener("click", () => openQrModal(b.dataset.slug, b.dataset.name))
    );
    tbody.querySelectorAll('button[data-action="edit"]').forEach((b) =>
      b.addEventListener("click", () => openEmployeeModal(b.dataset.id))
    );
    tbody.querySelectorAll('button[data-action="toggle"]').forEach((b) =>
      b.addEventListener("click", () => toggleActive(b.dataset.id, b.dataset.active === "true"))
    );
  }

  async function toggleActive(id, currentlyActive) {
    const { error } = await sb.from("employees").update({ active: !currentlyActive }).eq("id", id);
    if (!error) loadEmployees();
  }

  // ---- Модалка добавления/редактирования ----
  let editingEmployeeId = null;

  function openEmployeeModal(id) {
    editingEmployeeId = id || null;
    $("employee-modal-error").classList.remove("show");
    if (id) {
      const emp = employeesCache.find((e) => e.id === id);
      $("employee-modal-title").textContent = "Редактировать сотрудника";
      $("employee-name").value = emp.full_name;
      $("employee-role").value = emp.role;
      $("employee-branch").value = emp.branch;
    } else {
      $("employee-modal-title").textContent = "Новый сотрудник";
      $("employee-name").value = "";
      $("employee-role").value = "manager";
      $("employee-branch").value = "khujand";
    }
    $("employee-modal").style.display = "flex";
  }
  function closeEmployeeModal() { $("employee-modal").style.display = "none"; }

  $("add-employee-btn").addEventListener("click", () => openEmployeeModal(null));
  $("employee-modal-cancel").addEventListener("click", closeEmployeeModal);

  $("employee-modal-save").addEventListener("click", async () => {
    const name = $("employee-name").value.trim();
    const role = $("employee-role").value;
    const branch = $("employee-branch").value;
    if (!name) {
      $("employee-modal-error").textContent = "Укажите имя сотрудника.";
      $("employee-modal-error").classList.add("show");
      return;
    }

    if (editingEmployeeId) {
      const { error } = await sb
        .from("employees")
        .update({ full_name: name, role, branch })
        .eq("id", editingEmployeeId);
      if (error) {
        $("employee-modal-error").textContent = "Не удалось сохранить изменения.";
        $("employee-modal-error").classList.add("show");
        return;
      }
    } else {
      const slug = slugify(name);
      const { error } = await sb
        .from("employees")
        .insert({ slug, full_name: name, role, branch, active: true });
      if (error) {
        $("employee-modal-error").textContent = "Не удалось создать сотрудника.";
        $("employee-modal-error").classList.add("show");
        return;
      }
    }
    closeEmployeeModal();
    loadEmployees();
  });

  // ---- Модалка QR ----
  function openQrModal(slug, name) {
    const link = new URL(`../review.html?m=${encodeURIComponent(slug)}`, window.location.href).toString();
    $("qr-modal-name").textContent = `QR-код · ${name}`;
    $("qr-link-text").textContent = link;
    const holder = $("qr-canvas-holder");
    holder.innerHTML = "";
    const canvas = document.createElement("canvas");
    holder.appendChild(canvas);
    QRCode.toCanvas(canvas, link, { width: 220, margin: 1, color: { dark: "#241E18", light: "#FFFFFF" } });
    $("qr-modal-download").onclick = () => {
      const a = document.createElement("a");
      a.download = `qr-${slug}.png`;
      a.href = canvas.toDataURL("image/png");
      a.click();
    };
    $("qr-modal").style.display = "flex";
  }
  $("qr-modal-close").addEventListener("click", () => ($("qr-modal").style.display = "none"));

  // ---------------------------------------------------------
  // Отзывы
  // ---------------------------------------------------------
  function fillEmployeeFilter(rows) {
    const sel = $("filter-employee");
    const current = sel.value;
    sel.innerHTML = `<option value="">Все сотрудники</option>` +
      rows.map((e) => `<option value="${esc(e.id)}">${esc(e.full_name)}</option>`).join("");
    sel.value = current;
  }

  async function loadReviews() {
    let query = sb
      .from("reviews")
      .select("id, rating, comment, flagged, created_at, employees(full_name, branch)")
      .order("created_at", { ascending: false })
      .limit(300);

    const empId = $("filter-employee").value;
    const branch = $("filter-branch").value;
    const period = $("filter-period").value;
    const onlyFlagged = $("filter-flagged").checked;

    if (empId) query = query.eq("employee_id", empId);
    if (onlyFlagged) query = query.eq("flagged", true);
    if (period) {
      const since = new Date(Date.now() - Number(period) * 24 * 60 * 60 * 1000).toISOString();
      query = query.gte("created_at", since);
    }

    const { data, error } = await query;
    const tbody = $("reviews-tbody");

    if (error || !data) {
      tbody.innerHTML = `<tr><td colspan="6" class="hint">Не удалось загрузить отзывы.</td></tr>`;
      return;
    }

    let rows = data;
    if (branch) rows = rows.filter((r) => r.employees?.branch === branch);

    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="hint">Отзывов не найдено.</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map((r) => `
      <tr>
        <td>${new Date(r.created_at).toLocaleString("ru-RU")}</td>
        <td>${esc(r.employees?.full_name || "—")}</td>
        <td>${BRANCH_LABELS[r.employees?.branch] || "—"}</td>
        <td>${"●".repeat(Math.max(0, Math.min(5, r.rating | 0)))}${"○".repeat(5 - Math.max(0, Math.min(5, r.rating | 0)))}</td>
        <td>${r.comment ? esc(r.comment) : "<span class='hint'>без комментария</span>"}</td>
        <td>${r.flagged ? `<span class="badge badge--flag">подозрительный</span>` : ""}</td>
      </tr>
    `).join("");
  }

  ["filter-employee", "filter-branch", "filter-period", "filter-flagged"].forEach((id) =>
    $(id).addEventListener("change", loadReviews)
  );

  // ---------------------------------------------------------
  // Аналитика
  // ---------------------------------------------------------
  let chartByEmployee = null;
  let chartTrend = null;

  async function loadAnalytics() {
    const { data: stats } = await sb.from("employee_stats").select("*").order("avg_rating", { ascending: false });
    const withReviews = (stats || []).filter((e) => e.reviews_count > 0);

    const ctx1 = $("chart-by-employee").getContext("2d");
    if (chartByEmployee) chartByEmployee.destroy();
    chartByEmployee = new Chart(ctx1, {
      type: "bar",
      data: {
        labels: withReviews.map((e) => e.full_name),
        datasets: [{ label: "Средняя оценка", data: withReviews.map((e) => e.avg_rating), backgroundColor: "#FF6600", borderRadius: 6 }],
      },
      options: { scales: { y: { min: 0, max: 5 } }, plugins: { legend: { display: false } } },
    });

    const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: recentReviews } = await sb
      .from("reviews")
      .select("rating, created_at")
      .gte("created_at", since30)
      .order("created_at", { ascending: true });

    const byDay = {};
    (recentReviews || []).forEach((r) => {
      const day = r.created_at.slice(0, 10);
      if (!byDay[day]) byDay[day] = [];
      byDay[day].push(r.rating);
    });
    const days = Object.keys(byDay).sort();
    const avgPerDay = days.map((d) => (byDay[d].reduce((a, b) => a + b, 0) / byDay[d].length).toFixed(2));

    const ctx2 = $("chart-trend").getContext("2d");
    if (chartTrend) chartTrend.destroy();
    chartTrend = new Chart(ctx2, {
      type: "line",
      data: {
        labels: days,
        datasets: [{ label: "Средний рейтинг", data: avgPerDay, borderColor: "#C24C10", backgroundColor: "#FFE3CC", fill: true, tension: 0.3 }],
      },
      options: { scales: { y: { min: 0, max: 5 } }, plugins: { legend: { display: false } } },
    });
  }

  tryEnterApp();
})();
