(function () {
  const BRANCH_LABELS = { khujand: "Худжанд", dushanbe: "Душанбе" };
  const ROLE_LABELS = { manager: "Менеджер", consultant: "Консультант", other: "Сотрудник" };

  const params = new URLSearchParams(window.location.search);
  // /select?branch=khujand  (укажите этот параметр в QR-ссылке филиала)
  const branch = params.get("branch");

  const listEl = document.getElementById("employee-list");
  const labelEl = document.getElementById("branch-label");

  async function load() {
    if (branch) {
      labelEl.textContent = `Кого вы хотите оценить? · ${BRANCH_LABELS[branch] || branch}`;
    }

    let query = window.supabaseClient
      .from("employees")
      .select("slug, full_name, role, branch")
      .eq("active", true)
      .order("full_name", { ascending: true });

    if (branch) query = query.eq("branch", branch);

    const { data, error } = await query;

    if (error || !data || data.length === 0) {
      listEl.innerHTML = `<p class="hint">Сейчас нет доступных сотрудников для оценки.</p>`;
      return;
    }

    listEl.innerHTML = "";
    data.forEach((emp) => {
      const a = document.createElement("a");
      a.className = "list-item";
      a.href = `review.html?m=${encodeURIComponent(emp.slug)}`;
      a.innerHTML = `
        <div class="employee__avatar" style="width:40px;height:40px;font-size:14px;">
          ${emp.full_name.trim().split(/\s+/).slice(0, 2).map(p => p[0]).join("").toUpperCase()}
        </div>
        <div>
          <div style="font-weight:600;">${emp.full_name}</div>
          <div class="employee__meta">${ROLE_LABELS[emp.role] || emp.role}${branch ? "" : " · " + (BRANCH_LABELS[emp.branch] || emp.branch)}</div>
        </div>`;
      listEl.appendChild(a);
    });
  }

  load();
})();
