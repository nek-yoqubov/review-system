(function () {
  const ROLE_LABELS = { manager: "Менеджер", consultant: "Консультант", other: "Сотрудник" };
  const BRANCH_LABELS = { khujand: "Худжанд", dushanbe: "Душанбе" };

  const el = (id) => document.getElementById(id);
  const show = (id) => {
    ["state-loading", "state-form", "state-thanks", "state-already", "state-unavailable"]
      .forEach((s) => (el(s).style.display = s === id ? "" : "none"));
  };

  const params = new URLSearchParams(window.location.search);
  const slug = params.get("m");

  let selectedRating = 0;
  let employee = null;

  function storageKey(empSlug) {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (локальная дата устройства)
    return `reviewed_${empSlug}_${today}`;
  }

  function alreadyReviewedToday(empSlug) {
    try {
      return localStorage.getItem(storageKey(empSlug)) === "1";
    } catch (e) {
      return false; // приватный режим и т.п. — не блокируем, сервер всё равно проверит
    }
  }

  function markReviewedToday(empSlug) {
    try { localStorage.setItem(storageKey(empSlug), "1"); } catch (e) {}
  }

  // Случайный ID устройства/браузера — не для идентификации личности, а чтобы
  // сервер отличал разных клиентов, сидящих за одним IP (Wi-Fi шоурума).
  function getClientId() {
    try {
      let id = localStorage.getItem("promebel_client_id");
      if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem("promebel_client_id", id);
      }
      return id;
    } catch (e) {
      return ""; // приватный режим — сервер продолжит работать по IP+UA, просто без этого слоя
    }
  }

  function initials(name) {
    return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join("").toUpperCase();
  }

  async function loadEmployee() {
    if (!slug) {
      el("unavailable-text").textContent = "Не указан сотрудник — проверьте QR-код или ссылку.";
      show("state-unavailable");
      return;
    }

    if (alreadyReviewedToday(slug)) {
      show("state-already");
      return;
    }

    const { data, error } = await window.supabaseClient
      .from("employees")
      .select("id, slug, full_name, role, branch, active")
      .eq("slug", slug)
      .eq("active", true)
      .maybeSingle();

    if (error || !data) {
      el("unavailable-text").textContent = "Ссылка устарела или сотрудник больше не работает в Pro Mebel.";
      show("state-unavailable");
      return;
    }

    employee = data;
    el("emp-initials").textContent = initials(employee.full_name);
    el("emp-name").textContent = employee.full_name;
    el("emp-meta").textContent = `${ROLE_LABELS[employee.role] || employee.role} · ${BRANCH_LABELS[employee.branch] || employee.branch}`;
    show("state-form");
  }

  function setupSwatches() {
    const buttons = Array.from(document.querySelectorAll("#swatches .swatch"));
    buttons.forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedRating = Number(btn.dataset.v);
        buttons.forEach((b) => b.classList.toggle("is-filled", Number(b.dataset.v) <= selectedRating));
        el("submit-btn").disabled = false;
      });
    });
  }

  function setError(msg) {
    const box = el("form-error");
    if (!msg) { box.classList.remove("show"); box.textContent = ""; return; }
    box.textContent = msg;
    box.classList.add("show");
  }

  async function submitReview() {
    if (!employee || !selectedRating) return;
    const btn = el("submit-btn");
    btn.disabled = true;
    btn.textContent = "Отправляем…";
    setError("");

    try {
      const res = await fetch(window.EDGE_FUNCTION_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${window.PROMEBEL_CONFIG.SUPABASE_ANON_KEY}`,
          "apikey": window.PROMEBEL_CONFIG.SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          employee_slug: employee.slug,
          rating: selectedRating,
          comment: el("comment").value.trim().slice(0, 500),
          client_id: getClientId(),
        }),
      });

      const payload = await res.json().catch(() => ({}));

      if (res.status === 429 || payload.code === "ALREADY_REVIEWED") {
        markReviewedToday(employee.slug);
        show("state-already");
        return;
      }

      if (!res.ok) {
        throw new Error(payload.message || "Не удалось отправить оценку");
      }

      markReviewedToday(employee.slug);
      show("state-thanks");
    } catch (e) {
      setError("Не получилось отправить оценку. Проверьте связь и попробуйте ещё раз.");
      btn.disabled = false;
      btn.textContent = "Отправить оценку";
    }
  }

  setupSwatches();
  el("submit-btn").addEventListener("click", submitReview);
  loadEmployee();
})();
