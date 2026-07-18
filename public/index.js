// ============ CONFIG ============
// Automatically determine the API URL.
// Pointing to the new backend port: 3001
const API_URL =
  window.location.port !== "3001" &&
  (window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1")
    ? "http://localhost:3001/api"
    : "/api";

// ============ STATE ============
let allItems = [];
let allRecipes = [];
let currentSort = "expiry";
let currentCategory = "all";
let searchQuery = "";
let pendingDeleteId = null;

// ============ AUTH HELPERS ============

function getToken() {
  return localStorage.getItem("sp_token");
}
function getUser() {
  try {
    return JSON.parse(localStorage.getItem("sp_user") || "null");
  } catch {
    localStorage.removeItem("sp_user");
    return null;
  }
}

function applyAnalyzedItem(item) {
  if (!item) return false;
  let applied = false;
  if (item.name) {
    document.getElementById("itemName").value = item.name;
    handleItemNameInput(item.name);
    applied = true;
  }
  if (item.category) {
    document.getElementById("category").value = item.category;
  }
  if (item.expirationDate) {
    document.getElementById("expirationDate").value =
      item.expirationDate.split("T")[0];
    applied = true;
  }
  if (!document.getElementById("quantity").value) {
    document.getElementById("quantity").value = 1;
  }
  return applied;
}

function authHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${getToken()}`,
  };
}

function logout() {
  localStorage.removeItem("sp_token");
  localStorage.removeItem("sp_user");
  showAuth();
}

// ============ INIT ============

document.addEventListener("DOMContentLoaded", () => {
  registerServiceWorker();
  if (getToken()) {
    initApp();
  } else {
    showAuth();
  }
});

async function initApp() {
  const user = getUser();
  if (user) {
    document.getElementById("userName").textContent = user.name || "User";
    document.getElementById("userEmail").textContent = user.email || "";
    document.getElementById("userInitial").textContent = (user.name ||
      "U")[0].toUpperCase();
  }

  try {
    const res = await fetch(`${API_URL}/auth/me`, { headers: authHeaders() });
    if (!res.ok) {
      logout();
      return;
    }
  } catch {
    // allow offline fallback
  }

  document.getElementById("authScreen").style.display = "none";
  document.getElementById("appContainer").style.display = "block";

  await loadPantryItems();
  updateDashboard();
  loadNotifications();
  checkExpiryAlerts();
  updatePushBanner();
}

// ============ AUTH SCREEN ============

function showAuth(tab = "login") {
  document.getElementById("authScreen").style.display = "flex";
  document.getElementById("appContainer").style.display = "none";
  switchAuthTab(tab);
}

function switchAuthTab(tab) {
  document.getElementById("loginForm").style.display =
    tab === "login" ? "block" : "none";
  document.getElementById("registerForm").style.display =
    tab === "register" ? "block" : "none";
  document
    .querySelectorAll(".auth-tab")
    .forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
}

async function handleLogin(event) {
  event.preventDefault();
  const email = document.getElementById("loginEmail").value;
  const password = document.getElementById("loginPassword").value;
  const btn = document.getElementById("loginBtn");

  btn.disabled = true;
  btn.textContent = "Signing in…";

  try {
    const res = await fetch(`${API_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      showAuthError(data.error);
      return;
    }

    localStorage.setItem("sp_token", data.token);
    localStorage.setItem("sp_user", JSON.stringify(data.user));
    initApp();
  } catch {
    showAuthError("Could not connect to server.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
}

async function handleRegister(event) {
  event.preventDefault();
  const name = document.getElementById("regName").value;
  const email = document.getElementById("regEmail").value;
  const password = document.getElementById("regPassword").value;
  const btn = document.getElementById("registerBtn");

  btn.disabled = true;
  btn.textContent = "Creating account…";

  try {
    const res = await fetch(`${API_URL}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      showAuthError(data.error);
      return;
    }

    localStorage.setItem("sp_token", data.token);
    localStorage.setItem("sp_user", JSON.stringify(data.user));
    initApp();
  } catch {
    showAuthError("Registration failed.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Create account";
  }
}

function showAuthError(msg) {
  const el = document.getElementById("authError");
  el.textContent = msg || "Something went wrong.";
  el.style.display = "block";
  setTimeout(() => {
    el.style.display = "none";
  }, 5000);
}

// ============ TAB SWITCHING ============

function switchTab(tabName, event) {
  document
    .querySelectorAll(".page")
    .forEach((p) => p.classList.remove("active"));
  document
    .querySelectorAll(".nav-tab")
    .forEach((t) => t.classList.remove("active"));

  document.getElementById(tabName).classList.add("active");
  if (event && event.target) event.target.classList.add("active");

  if (tabName === "pantry") loadPantryItems();
  else if (tabName === "recipes") loadRecipes();
  else if (tabName === "notifications") loadNotifications();
  else if (tabName === "shopping") loadShoppingList();
  else if (tabName === "analytics") loadAnalytics();
}

// ============ DASHBOARD ============

function updateDashboard() {
  const today = new Date();
  const sevenDays = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);

  let fresh = 0,
    warning = 0,
    expired = 0;
  allItems.forEach((item) => {
    const exp = new Date(item.expirationDate);
    if (exp < today) expired++;
    else if (exp <= sevenDays) warning++;
    else fresh++;
  });

  document.getElementById("totalItems").textContent = allItems.length;
  document.getElementById("freshItems").textContent = fresh;
  document.getElementById("warningItems").textContent = warning;
  document.getElementById("expiredItems").textContent = expired;
}

// ============ PANTRY ITEMS ============

async function loadPantryItems() {
  try {
    const params = new URLSearchParams();
    if (searchQuery) params.set("search", searchQuery);
    if (currentCategory !== "all") params.set("category", currentCategory);
    params.set("sort", currentSort);

    const res = await fetch(`${API_URL}/pantry?${params}`, {
      headers: authHeaders(),
    });
    if (res.status === 401) {
      logout();
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load pantry");
    allItems = Array.isArray(data) ? data : [];
    renderPantryItems();
    updateDashboard();
  } catch (error) {
    console.error(error);
    showToast("Could not load pantry items", "error");
  }
}

function applySearch(query) {
  searchQuery = query;
  loadPantryItems();
}

function applyFilter(category) {
  currentCategory = category;
  document
    .querySelectorAll(".filter-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.cat === category));
  loadPantryItems();
}

// Fix sorting selection logic
function applySort(sort) {
  currentSort = sort;
  document
    .querySelectorAll(".sort-btn")
    .forEach((b) => b.classList.toggle("active", b.dataset.sort === sort));
  loadPantryItems();
}

function renderPantryItems() {
  const list = document.getElementById("itemsList");

  if (allItems.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🥘</div>
        <div class="empty-title">${searchQuery || currentCategory !== "all" ? "No items match your filters" : "Your pantry is empty"}</div>
        <p>${searchQuery || currentCategory !== "all" ? "Try adjusting your search or filter." : "Add your first item to get started!"}</p>
      </div>`;
    return;
  }

  list.innerHTML = allItems
    .map((item) => {
      const status = getItemStatus(item.expirationDate);
      const escapedName = escapeHtml(item.name);
      // Double escaping inside strings dynamically rendered within HTML template literals
      const dynamicConfirmArgs = `confirmDelete('${item.id}', \`${escapedName.replace(/`/g, "\\`").replace(/'/g, "\\'")}\`)`;

      return `
      <div class="item" id="item-${item.id}">
        <div class="item-info">
          <div class="item-name">${escapedName}</div>
          <div class="item-details">${item.category} • Expires ${new Date(item.expirationDate).toLocaleDateString()}</div>
          <span class="item-status ${status.class}">${status.text}</span>
        </div>
        <div class="item-actions">
          <div class="qty-controls">
            <button class="btn-qty" onclick="adjustQuantity('${item.id}', -1)" aria-label="Decrease quantity">−</button>
            <span class="qty-value">${item.quantity} ${item.unit}</span>
            <button class="btn-qty" onclick="adjustQuantity('${item.id}', 1)" aria-label="Increase quantity">+</button>
          </div>
          <button class="btn-icon" onclick="openEditModal('${item.id}')" aria-label="Edit ${escapedName}">✏️</button>
          <button class="btn-icon delete" onclick="${dynamicConfirmArgs}" aria-label="Delete ${escapedName}">🗑️</button>
        </div>
        <div class="inline-confirm" id="confirm-${item.id}" style="display:none">
          <span>Delete <strong>${escapedName}</strong>?</span>
          <button class="btn-confirm-yes" onclick="deleteItem('${item.id}')">Delete</button>
          <button class="btn-confirm-no" onclick="cancelDelete('${item.id}')">Cancel</button>
        </div>
      </div>`;
    })
    .join("");
}

async function adjustQuantity(itemId, delta) {
  const item = allItems.find((i) => i.id === itemId);
  if (!item) return;
  const newQty = Math.max(1, item.quantity + delta);
  if (newQty === item.quantity) return;

  try {
    const res = await fetch(`${API_URL}/pantry/${itemId}`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ quantity: newQty }),
    });
    if (!res.ok) throw new Error();
    item.quantity = newQty;
    const qtyEl = document.querySelector(`#item-${itemId} .qty-value`);
    if (qtyEl) qtyEl.textContent = `${newQty} ${item.unit}`;
    updateDashboard();
  } catch {
    showToast("Could not update quantity", "error");
  }
}

function getItemStatus(expirationDate) {
  const today = new Date();
  const exp = new Date(expirationDate);
  const days = Math.ceil((exp - today) / (1000 * 60 * 60 * 24));
  if (days < 0)
    return { class: "expired", text: `❌ Expired ${Math.abs(days)}d ago` };
  if (days <= 3) return { class: "warning", text: `⚠️ Expires in ${days}d` };
  return { class: "fresh", text: `✅ Fresh` };
}

function confirmDelete(itemId, itemName) {
  if (pendingDeleteId && pendingDeleteId !== itemId)
    cancelDelete(pendingDeleteId);
  pendingDeleteId = itemId;
  const targetEl = document.getElementById(`confirm-${itemId}`);
  if (targetEl) targetEl.style.display = "flex";
}

function cancelDelete(itemId) {
  pendingDeleteId = null;
  const el = document.getElementById(`confirm-${itemId}`);
  if (el) el.style.display = "none";
}

async function deleteItem(itemId) {
  try {
    const res = await fetch(`${API_URL}/pantry/${itemId}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (!res.ok) throw new Error();
    showToast("Item deleted", "success");
    pendingDeleteId = null;
    await loadPantryItems();
  } catch {
    showToast("Could not delete item", "error");
  }
}

// ============ ADD ITEM FORM ============

const COMMON_ITEMS = {
  milk: { category: "dairy", unit: "L" },
  eggs: { category: "dairy", unit: "piece" },
  butter: { category: "dairy", unit: "g" },
  cheese: { category: "dairy", unit: "g" },
  yogurt: { category: "dairy", unit: "g" },
  bread: { category: "pantry", unit: "piece" },
  rice: { category: "pantry", unit: "kg" },
  pasta: { category: "pantry", unit: "g" },
};

function handleItemNameInput(value) {
  const lower = value.toLowerCase().trim();
  const suggestions = Object.keys(COMMON_ITEMS).filter(
    (k) => k.startsWith(lower) && lower.length > 0,
  );
  const datalist = document.getElementById("itemSuggestions");
  datalist.innerHTML = suggestions
    .map((s) => `<option value="${s.charAt(0).toUpperCase() + s.slice(1)}">`)
    .join("");

  if (COMMON_ITEMS[lower]) {
    document.getElementById("category").value = COMMON_ITEMS[lower].category;
    document.getElementById("unit").value = COMMON_ITEMS[lower].unit;
  }
}

async function handleAddItem(event) {
  event.preventDefault();

  const name = document.getElementById("itemName").value.trim();
  const quantity = document.getElementById("quantity").value;
  const unit = document.getElementById("unit").value;
  const category = document.getElementById("category").value;
  const expirationDate = document.getElementById("expirationDate").value;
  const notes = document.getElementById("notes").value.trim();

  if (!name || !expirationDate) {
    showToast("Item name and expiry date are required", "error");
    return;
  }

  const btn = document.getElementById("addBtn");
  btn.disabled = true;
  btn.textContent = "Adding…";

  try {
    const res = await fetch(`${API_URL}/pantry`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        name,
        quantity: parseInt(quantity),
        unit,
        category,
        expirationDate,
        notes,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || "Could not add item", "error");
      return;
    }

    showToast("Item added!", "success");
    document.getElementById("addItemForm").reset();
    document.getElementById("photoPreview").style.display = "none";
    await loadPantryItems();
  } catch {
    showToast("Could not add item.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "➕ Add Item";
  }
}

// ============ EDIT MODAL ============

function openEditModal(itemId) {
  const item = allItems.find((i) => i.id === itemId);
  if (!item) return;

  document.getElementById("editItemId").value = item.id;
  document.getElementById("editItemName").value = item.name;
  document.getElementById("editQuantity").value = item.quantity;
  document.getElementById("editUnit").value = item.unit;
  document.getElementById("editCategory").value = item.category;
  document.getElementById("editExpirationDate").value =
    item.expirationDate.split("T")[0];
  document.getElementById("editNotes").value = item.notes || "";
  document.getElementById("editModal").classList.add("active");
}

function closeEditModal() {
  document.getElementById("editModal").classList.remove("active");
}

async function handleEditItem(event) {
  event.preventDefault();

  const itemId = document.getElementById("editItemId").value;
  const name = document.getElementById("editItemName").value.trim();
  const quantity = document.getElementById("editQuantity").value;
  const unit = document.getElementById("editUnit").value;
  const category = document.getElementById("editCategory").value;
  const expirationDate = document.getElementById("editExpirationDate").value;
  const notes = document.getElementById("editNotes").value.trim();

  try {
    const res = await fetch(`${API_URL}/pantry/${itemId}`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({
        name,
        quantity: parseInt(quantity),
        unit,
        category,
        expirationDate,
        notes,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || "Could not update item", "error");
      return;
    }

    showToast("Item updated!", "success");
    closeEditModal();
    await loadPantryItems();
  } catch {
    showToast("Could not update item", "error");
  }
}

// ============ SHOPPING LIST ============

async function loadShoppingList() {
  try {
    const res = await fetch(`${API_URL}/shopping-list`, {
      headers: authHeaders(),
    });
    const list = await res.json();
    if (!res.ok) throw new Error(list.error || "Failed to load shopping list");
    renderShoppingList(Array.isArray(list) ? list : []);
  } catch {
    showToast("Could not load shopping list", "error");
  }
}

function renderShoppingList(list) {
  const container = document.getElementById("shoppingList");
  if (list.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🛒</div>
        <div class="empty-title">Nothing to buy right now</div>
      </div>`;
    return;
  }

  const expired = list.filter((i) => i.reason === "expired");
  const soon = list.filter((i) => i.reason === "expiring_soon");

  let html = "";
  if (expired.length) {
    html += `<div class="section-label">Replace — already expired</div>`;
    html += expired.map((item) => shoppingItemHtml(item)).join("");
  }
  if (soon.length) {
    html += `<div class="section-label">Stock up — expiring soon</div>`;
    html += soon.map((item) => shoppingItemHtml(item)).join("");
  }
  container.innerHTML = html;
}

function shoppingItemHtml(item) {
  return `
    <div class="shopping-item" id="shop-${item.id}">
      <label class="shopping-check">
        <input type="checkbox" onchange="toggleShoppingItem('${item.id}', this)">
        <span class="checkmark"></span>
        <span class="shopping-name">${escapeHtml(item.name)}</span>
      </label>
    </div>`;
}

function toggleShoppingItem(itemId, checkbox) {
  const el = document.getElementById(`shop-${itemId}`);
  if (el) el.classList.toggle("checked", checkbox.checked);
}

// ============ ANALYTICS ============

async function loadAnalytics() {
  try {
    const res = await fetch(`${API_URL}/analytics`, { headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load analytics");
    renderAnalytics(data);
  } catch {
    showToast("Could not load analytics", "error");
  }
}

function renderAnalytics(data) {
  const summary = data.summary || {
    total: 0,
    fresh: 0,
    expiringSoon: 0,
    expired: 0,
  };
  const categoryBreakdown = data.categoryBreakdown || {};
  const container = document.getElementById("analyticsContent");

  const total = summary.total || 1;
  const wasteRate = total > 0 ? Math.round((summary.expired / total) * 100) : 0;

  const categoryRows = Object.entries(categoryBreakdown)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([cat, count]) => `
      <div class="analytics-row">
        <span class="analytics-label">${cat}</span>
        <div class="analytics-bar-wrap">
          <div class="analytics-bar" style="width:${Math.round((count / total) * 100)}%"></div>
        </div>
      </div>`,
    )
    .join("");

  container.innerHTML = `
    <div class="analytics-grid">
      <div class="analytics-card">
        <div class="analytics-big">${wasteRate}%</div>
        <div class="analytics-card-label">Expiry rate</div>
      </div>
    </div>
    <div class="card" style="margin-top:20px">${categoryRows}</div>`;
}

// ============ NOTIFICATIONS (in-app) ============

async function loadNotifications() {
  try {
    const res = await fetch(`${API_URL}/notifications`, {
      headers: authHeaders(),
    });
    const notifications = await res.json();
    if (!res.ok)
      throw new Error(notifications.error || "Failed to load notifications");
    renderNotifications(Array.isArray(notifications) ? notifications : []);
    updateNotificationBadge(notifications.length);
  } catch {
    console.error("Could not load notifications");
  }
}

function renderNotifications(notifications) {
  const container = document.getElementById("notificationsList");
  if (notifications.length === 0) {
    container.innerHTML = `<div class="empty-state"><p>All clear!</p></div>`;
    return;
  }
  container.innerHTML = notifications
    .map(
      (n) => `
    <div class="notification">
      <div class="notification-title">${escapeHtml(n.message)}</div>
    </div>`,
    )
    .join("");
}

function updateNotificationBadge(count) {
  const badge = document.getElementById("notifBadge");
  if (badge) {
    badge.textContent = count;
    badge.style.display = count > 0 ? "inline-flex" : "none";
  }
}

function checkExpiryAlerts() {
  const today = new Date();
  const threeDays = new Date(today.getTime() + 3 * 24 * 60 * 60 * 1000);
  const urgent = allItems.filter(
    (i) => new Date(i.expirationDate) <= threeDays,
  );
  if (urgent.length > 0) {
    showToast(`${urgent.length} items expiring within 3 days`, "warning");
  }
}

// ============ RECIPES ============

async function loadRecipes() {
  try {
    const res = await fetch(`${API_URL}/recipes`, { headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load recipes");
    allRecipes = Array.isArray(data) ? data : [];
    renderRecipes();
  } catch {
    console.error("Could not load recipes");
  }
}

async function generateRecipes() {
  if (allItems.length === 0) {
    showToast("Add items to your pantry first!", "error");
    return;
  }
  const btn = document.getElementById("generateBtn");
  btn.disabled = true;
  btn.textContent = "🍳 Generating…";

  try {
    const res = await fetch(`${API_URL}/generate-recipes`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        ingredients: allItems.map((i) => i.name).join(", "),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || "Could not generate recipes", "error");
      return;
    }
    allRecipes = data.recipes || [];
    renderRecipes();
    showToast("Recipes generated!", "success");
  } catch {
    showToast("Could not generate recipes", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "🍳 Generate Recipes";
  }
}

function renderRecipes() {
  const container = document.getElementById("recipesList");
  if (allRecipes.length === 0) {
    container.innerHTML = `<div class="empty-state"><p>No recipes yet</p></div>`;
    return;
  }
  container.innerHTML = allRecipes
    .map(
      (r) => `
    <div class="recipe">
      <div class="recipe-header">
        <div class="recipe-title">${escapeHtml(r.title)}</div>
        <div class="recipe-meta">⏱ ${r.prepTime || 20} min • 🍽 Serves ${r.servings || 2}</div>
      </div>
      <div class="recipe-body">
        <strong>Ingredients:</strong> ${escapeHtml(typeof r.ingredients === "string" ? r.ingredients : (r.ingredients || []).join(", "))}
        <br><br>
        <strong>Instructions:</strong><br>
        ${escapeHtml(r.instructions || "No instructions available.").replace(/\n/g, "<br>")}
      </div>
    </div>`,
    )
    .join("");
}

// ============ AI PHOTO ANALYSIS ============

function previewPhoto(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const preview = document.getElementById("photoPreview");
    preview.src = e.target.result;
    preview.style.display = "block";
  };
  reader.readAsDataURL(file);
}

// Enhanced integration flow for back-of-label metadata mapping
async function analyzeWithAI() {
  const photoFile = document.getElementById("photoUpload").files[0];
  if (!photoFile) {
    showToast("Upload a photo first", "error");
    return;
  }

  const btn = document.getElementById("analyzeBtn");
  btn.disabled = true;
  btn.textContent = "🤖 Analyzing…";

  try {
    const formData = new FormData();
    formData.append("file", photoFile);

    const res = await fetch(`${API_URL}/analyze-photo`, {
      method: "POST",
      headers: { Authorization: `Bearer ${getToken()}` },
      body: formData,
    });

    const data = await res.json();

    if (!res.ok) {
      showToast(data.error || "Photo analysis failed", "error");
      return;
    }

    if (data.item && applyAnalyzedItem(data.item)) {
      showToast(
        data.fallback
          ? data.message || "Partial details found — please verify"
          : `✨ Found: ${data.item.name}`,
        data.fallback ? "warning" : "success",
      );
      return;
    }

    showToast(data.message || "No items detected in photo", "warning");
  } catch (error) {
    console.error(error);
    showToast("Photo analysis failed", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "🤖 Analyze Photo";
  }
}

// ============ PWA / PUSH NOTIFICATIONS ============

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/sw.js");
  } catch (err) {
    console.error("Service worker registration failed:", err);
  }
}

// Converts the VAPID public key (base64) into the Uint8Array format the Push API expects
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// Show the "Enable Notifications" banner only when it's relevant:
// push is supported, permission hasn't been decided yet or was granted but we're not subscribed.
async function updatePushBanner() {
  const banner = document.getElementById("pushBanner");
  if (!banner) return;

  const supported = "serviceWorker" in navigator && "PushManager" in window;
  if (!supported) {
    banner.classList.remove("show");
    return;
  }

  if (Notification.permission === "denied") {
    banner.classList.remove("show");
    return;
  }

  try {
    const reg = await navigator.serviceWorker.ready;
    const existingSub = await reg.pushManager.getSubscription();
    banner.classList.toggle("show", !existingSub);
  } catch {
    banner.classList.add("show");
  }
}

async function enablePushNotifications() {
  const btn = document.getElementById("pushEnableBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Enabling…";
  }

  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      showToast("Push notifications aren't supported on this browser", "error");
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      showToast("Notification permission was not granted", "warning");
      return;
    }

    const keyRes = await fetch(`${API_URL}/push/public-key`, {
      headers: authHeaders(),
    });
    const keyData = await keyRes.json();
    if (!keyRes.ok) {
      showToast(keyData.error || "Push not available right now", "error");
      return;
    }

    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(keyData.publicKey),
    });

    const res = await fetch(`${API_URL}/push/subscribe`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(subscription),
    });

    if (!res.ok) {
      const data = await res.json();
      showToast(data.error || "Could not save subscription", "error");
      return;
    }

    showToast("Notifications enabled! 🔔", "success");
    updatePushBanner();
  } catch (error) {
    console.error("Push subscription failed:", error);
    showToast("Could not enable notifications", "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "🔔 Enable Notifications";
    }
  }
}

// ============ UTILITY ============

function escapeHtml(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showToast(message, type = "info") {
  document.querySelectorAll(".toast").forEach((t) => t.remove());

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add("toast-show"));
  setTimeout(() => {
    toast.classList.remove("toast-show");
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("editModal")?.addEventListener("click", function (e) {
    if (e.target === this) closeEditModal();
  });
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeEditModal();
});
