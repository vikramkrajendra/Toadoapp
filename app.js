(() => {
  'use strict';

  /* ---------- Config ---------- */
  const STORAGE_KEY = 'todo-tracker.v1';
  const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
  const STATUS_RANK = { overdue: 0, pending: 1, completed: 2 };
  const STATUS_LABEL = { completed: 'Completed', pending: 'Pending', overdue: 'Overdue' };
  const HORIZON_LABEL = { today: 'Today', week: 'This Week', month: 'This Month', all: 'All' };
  const RING_RADIUS = 52;
  const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

  /* ---------- State ---------- */
  const state = {
    tasks: loadTasks(),
    horizon: 'today',   // today | week | month | all
    month: null,        // 'YYYY-MM' shown by the Month view; set to the current month at start-up
    filter: 'all',      // all | pending | completed | overdue
    editingId: null,
    confirmDeleteId: null, // task waiting for a second click to delete
    undo: null,            // { removed: [{ task, index }], timer } for the Undo message
  };

  /* ---------- DOM ---------- */
  const $ = (sel) => document.querySelector(sel);
  const els = {
    todayLabel: $('#today-label'),
    statCards: $('#stat-cards'),
    ring: $('#ring-progress'),
    ringText: $('#ring-text'),
    barChart: $('#bar-chart'),
    form: $('#task-form'),
    formTitle: $('#form-title'),
    titleInput: $('#title'),
    titleError: $('#title-error'),
    titleCount: $('#title-count'),
    dueInput: $('#due'),
    dueError: $('#due-error'),
    prioInput: $('#priority'),
    notesInput: $('#notes'),
    submitBtn: $('#submit-btn'),
    cancelBtn: $('#cancel-btn'),
    tabs: $('#horizon-tabs'),
    chips: $('#filter-chips'),
    list: $('#task-list'),
    empty: $('#empty-state'),
    resultCount: $('#result-count'),
    summary: $('#summary'),
    newBtn: $('#new-btn'),
    formCard: $('.form-card'),
    toast: $('#toast'),
    toastText: $('#toast-text'),
    toastUndo: $('#toast-undo'),
    clearDoneBtn: $('#clear-done-btn'),
    monthLabel: $('#month-name'),
    monthPrev: $('#month-prev'),
    monthNext: $('#month-next'),
    monthBack: $('#month-back'),
    welcome: $('#welcome'),
    loadExamplesBtn: $('#load-examples-btn'),
    dismissWelcomeBtn: $('#dismiss-welcome-btn'),
    exportBtn: $('#export-btn'),
    importFile: $('#import-file'),
    backupStatus: $('#backup-status'),
  };

  const WELCOME_KEY = 'todo-tracker.welcome-dismissed';
  const BACKUP_FORMAT = 'activity-tracker-backup';

  /* ---------- Storage (guarded: works even if storage is blocked) ---------- */
  // Check each saved record so a damaged entry cannot break sorting or display.
  function sanitizeTask(t) {
    if (!t || typeof t !== 'object') return null;
    const title = typeof t.title === 'string' ? t.title.trim().slice(0, 120) : '';
    const dueDate = typeof t.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.dueDate) ? t.dueDate : '';
    if (!title || !dueDate) return null;
    return {
      id: String(t.id || newId()),
      title,
      notes: typeof t.notes === 'string' ? t.notes.slice(0, 500) : '',
      dueDate,
      priority: Object.prototype.hasOwnProperty.call(PRIORITY_RANK, t.priority) ? t.priority : 'medium',
      completed: t.completed === true,
      completedAt: typeof t.completedAt === 'string' ? t.completedAt : null,
      createdAt: typeof t.createdAt === 'string' ? t.createdAt : new Date().toISOString(),
    };
  }

  function loadTasks() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
      return Array.isArray(data) ? data.map(sanitizeTask).filter(Boolean) : [];
    } catch (err) {
      return [];
    }
  }

  function saveTasks() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.tasks));
    } catch (err) {
      // Storage unavailable: keep working in memory for this session.
    }
  }

  /* ---------- Dates (local time; YYYY-MM-DD strings compare correctly) ---------- */
  const pad = (n) => String(n).padStart(2, '0');
  const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayISO = () => toISO(new Date());

  function horizonRange(horizon) {
    const now = new Date();
    if (horizon === 'today') return [todayISO(), todayISO()];
    if (horizon === 'week') {
      const offset = (now.getDay() + 6) % 7; // Monday = 0 ... Sunday = 6
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset + 6);
      return [toISO(start), toISO(end)];
    }
    if (horizon === 'month') {
      const [y, m] = state.month.split('-').map(Number);
      const start = new Date(y, m - 1, 1);
      const end = new Date(y, m, 0);
      return [toISO(start), toISO(end)];
    }
    return null; // 'all'
  }

  /* ---------- Months (any year, chosen with the month picker) ---------- */
  const monthKeyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  const currentMonthKey = () => monthKeyOf(new Date());

  // Move a 'YYYY-MM' key by a number of months (negative goes back).
  function shiftMonth(key, delta) {
    const [y, m] = key.split('-').map(Number);
    return monthKeyOf(new Date(y, m - 1 + delta, 1));
  }

  // Full month name, e.g. "December 2026".
  function monthNameOf(key) {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  // "This Month" for the current month, otherwise the month name.
  function monthName(key) {
    return key === currentMonthKey() ? 'This Month' : monthNameOf(key);
  }

  // Label for a period tab, card or bar; the month shows its name when it is not the current one.
  function labelFor(horizon) {
    return horizon === 'month' ? monthName(state.month) : HORIZON_LABEL[horizon];
  }

  // Completion time is stored in UTC; show it in the viewer's local day.
  function formatCompleted(isoTimestamp) {
    const d = new Date(isoTimestamp);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function formatDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric',
    });
  }

  /* ---------- Task logic ---------- */
  function statusOf(task) {
    if (task.completed) return 'completed';
    if (task.dueDate < todayISO()) return 'overdue';
    return 'pending';
  }

  // A task belongs to a period if it is due inside it, or if it is overdue (so nothing gets lost).
  function inHorizon(task, horizon) {
    const range = horizonRange(horizon);
    if (!range) return true;
    const [from, to] = range;
    return (task.dueDate >= from && task.dueDate <= to) || statusOf(task) === 'overdue';
  }

  function compareTasks(a, b) {
    return STATUS_RANK[statusOf(a)] - STATUS_RANK[statusOf(b)]
      || a.dueDate.localeCompare(b.dueDate)
      || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  }

  function visibleTasks() {
    return state.tasks
      .filter((t) => inHorizon(t, state.horizon))
      .filter((t) => state.filter === 'all' || statusOf(t) === state.filter)
      .sort(compareTasks);
  }

  function countsFor(horizon) {
    const counts = { total: 0, completed: 0, pending: 0, overdue: 0 };
    state.tasks.forEach((t) => {
      if (!inHorizon(t, horizon)) return;
      counts.total++;
      counts[statusOf(t)]++;
    });
    return counts;
  }

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function addTask(fields) {
    state.tasks.push({
      id: newId(),
      ...fields,
      completed: false,
      completedAt: null,
      createdAt: new Date().toISOString(),
    });
  }

  function updateTask(id, fields) {
    const task = state.tasks.find((t) => t.id === id);
    if (task) Object.assign(task, fields);
  }

  function toggleComplete(id) {
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return;
    task.completed = !task.completed;
    task.completedAt = task.completed ? new Date().toISOString() : null;
  }

  function deleteTask(id) {
    state.tasks = state.tasks.filter((t) => t.id !== id);
  }

  /* ---------- Welcome, examples, backup ---------- */
  function welcomeDismissed() {
    try { return localStorage.getItem(WELCOME_KEY) === '1'; } catch (err) { return false; }
  }

  function dismissWelcome() {
    try { localStorage.setItem(WELCOME_KEY, '1'); } catch (err) { /* storage blocked */ }
  }

  function loadExamples() {
    const examples = [
      { title: 'Example: Reply to client emails', dueDate: iso(0), priority: 'high', notes: 'Example. Delete when you are ready.' },
      { title: 'Example: Plan next week', dueDate: iso(3), priority: 'medium', notes: 'Example. Delete when you are ready.' },
      { title: 'Example: Book a dentist check-up', dueDate: iso(9), priority: 'low', notes: 'Example. Delete when you are ready.' },
    ];
    examples.forEach((ex) => addTask(ex));
    saveTasks();
    render();
  }

  function iso(offsetDays) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return toISO(d);
  }

  function exportBackup() {
    const payload = {
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      tasks: state.tasks,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `focusline-backup-${todayISO()}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setBackupStatus(`Backup saved with ${state.tasks.length} activities.`, true);
  }

  function setBackupStatus(message, ok) {
    els.backupStatus.textContent = message;
    els.backupStatus.classList.toggle('is-ok', Boolean(ok));
    els.backupStatus.classList.toggle('is-error', !ok && Boolean(message));
  }

  function importBackup(file) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setBackupStatus('That file is too large to be a Focusline backup.', false);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try {
        data = JSON.parse(String(reader.result));
      } catch (err) {
        setBackupStatus('That file is not valid JSON. Your activities were not changed.', false);
        return;
      }
      const list = Array.isArray(data) ? data : (data && data.format === BACKUP_FORMAT ? data.tasks : null);
      if (!Array.isArray(list)) {
        setBackupStatus('This is not a Focusline backup. Your activities were not changed.', false);
        return;
      }
      const incoming = list.map(sanitizeTask).filter(Boolean);
      if (incoming.length === 0) {
        setBackupStatus('The backup has no valid activities. Your activities were not changed.', false);
        return;
      }
      // Merge: keep existing activities and add any whose id is not already present.
      const existingIds = new Set(state.tasks.map((t) => t.id));
      let added = 0;
      incoming.forEach((t) => {
        if (!existingIds.has(t.id)) {
          state.tasks.push(t);
          existingIds.add(t.id);
          added++;
        }
      });
      saveTasks();
      render();
      setBackupStatus(`Imported ${added} new ${added === 1 ? 'activity' : 'activities'}. ${incoming.length - added} already here.`, true);
    };
    reader.onerror = () => setBackupStatus('The file could not be read. Your activities were not changed.', false);
    reader.readAsText(file);
  }

  els.welcome.addEventListener('click', (e) => {
    if (e.target === els.loadExamplesBtn) loadExamples();
    if (e.target === els.dismissWelcomeBtn) {
      dismissWelcome();
      render();
    }
  });

  els.exportBtn.addEventListener('click', exportBackup);
  els.importFile.addEventListener('change', (e) => {
    importBackup(e.target.files[0]);
    e.target.value = ''; // allow importing the same file again
  });

  /* ---------- Form ---------- */
  function setError(input, errorEl, message) {
    errorEl.textContent = message || '';
    input.classList.toggle('is-invalid', Boolean(message));
  }

  function clearErrors() {
    setError(els.titleInput, els.titleError, '');
    setError(els.dueInput, els.dueError, '');
  }

  function resetForm() {
    els.form.reset();
    clearErrors();
    els.dueInput.min = todayISO();
    els.dueInput.value = todayISO();
    els.prioInput.value = 'medium';
    state.editingId = null;
    els.formTitle.textContent = 'Add an activity';
    els.submitBtn.textContent = 'Add activity';
    updateTitleCount();
  }

  function openForm() {
    els.formCard.hidden = false;
    els.newBtn.setAttribute('aria-expanded', 'true');
  }

  function closeForm() {
    els.formCard.hidden = true;
    els.newBtn.setAttribute('aria-expanded', 'false');
  }

  function startEdit(id) {
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return;
    state.editingId = id;
    els.titleInput.value = task.title;
    els.dueInput.value = task.dueDate;
    els.prioInput.value = task.priority;
    els.notesInput.value = task.notes || '';
    els.formTitle.textContent = 'Edit activity';
    els.submitBtn.textContent = 'Save changes';
    updateTitleCount();
    openForm();
    els.form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    els.titleInput.focus();
  }

  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearErrors();

    const title = els.titleInput.value.trim();
    const dueDate = els.dueInput.value;
    const existing = state.editingId ? state.tasks.find((t) => t.id === state.editingId) : null;

    // Title must contain at least one letter, so numbers alone are rejected.
    if (!title) {
      setError(els.titleInput, els.titleError, 'Please enter an activity.');
      els.titleInput.focus();
      return;
    }
    if (!/\p{L}/u.test(title)) {
      setError(els.titleInput, els.titleError, 'Use words to describe the activity, not just numbers.');
      els.titleInput.focus();
      return;
    }

    // A due date is required.
    if (!dueDate) {
      setError(els.dueInput, els.dueError, 'Pick a due date.');
      els.dueInput.focus();
      return;
    }

    // Due date cannot be in the past. An existing task keeps its old date when only its text changes.
    const dateChanged = !existing || existing.dueDate !== dueDate;
    if (dateChanged && dueDate < todayISO()) {
      setError(els.dueInput, els.dueError, 'Due date cannot be in the past. Pick today or a later date.');
      els.dueInput.focus();
      return;
    }

    const fields = {
      title,
      dueDate,
      priority: els.prioInput.value,
      notes: els.notesInput.value.trim(),
    };
    if (state.editingId) updateTask(state.editingId, fields);
    else addTask(fields);

    saveTasks();
    resetForm();
    closeForm();
    render();
  });

  // Show the character count only when the title nears its limit.
  function updateTitleCount() {
    const len = els.titleInput.value.length;
    els.titleCount.textContent = len >= 100 ? `${len}/120` : '';
  }

  // Check the title as the user types, so numbers-only input is flagged immediately.
  els.titleInput.addEventListener('input', () => {
    const value = els.titleInput.value.trim();
    const message = value && !/\p{L}/u.test(value)
      ? 'Use words to describe the activity, not just numbers.'
      : '';
    setError(els.titleInput, els.titleError, message);
    updateTitleCount();
  });
  els.dueInput.addEventListener('input', () => setError(els.dueInput, els.dueError, ''));

  els.cancelBtn.addEventListener('click', () => {
    resetForm();
    closeForm();
  });

  els.newBtn.addEventListener('click', () => {
    if (!els.formCard.hidden && !state.editingId) {
      // Already open for a new activity: close it.
      resetForm();
      closeForm();
      return;
    }
    resetForm();
    openForm();
    els.titleInput.focus();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.formCard.hidden) {
      resetForm();
      closeForm();
    }
  });

  /* ---------- Controls ---------- */
  els.tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-horizon]');
    if (!btn) return;
    state.horizon = btn.dataset.horizon;
    render();
  });

  // Month picker: move the Month view to any month, and back to the current one.
  els.monthPrev.addEventListener('click', () => {
    state.month = shiftMonth(state.month, -1);
    render();
  });
  els.monthNext.addEventListener('click', () => {
    state.month = shiftMonth(state.month, 1);
    render();
  });
  els.monthBack.addEventListener('click', () => {
    state.month = currentMonthKey();
    render();
  });

  // Jump to a period or status view, then bring the list into sight.
  function openView(el) {
    if (el.dataset.goHorizon) {
      state.horizon = el.dataset.goHorizon;
      state.filter = 'all';
      if (state.horizon === 'month') state.month = currentMonthKey();
    } else if (el.dataset.goFilter) {
      state.horizon = 'all';
      state.filter = el.dataset.goFilter;
    } else {
      return;
    }
    render();
    document.querySelector('.list-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // Stat cards, period bars and status legend items all open a view.
  els.statCards.addEventListener('click', (e) => {
    const el = e.target.closest('[data-go-horizon], [data-go-filter]');
    if (el) openView(el);
  });

  els.barChart.addEventListener('click', (e) => {
    const el = e.target.closest('[data-go-horizon]');
    if (el) openView(el);
  });

  document.querySelector('.legend').addEventListener('click', (e) => {
    const el = e.target.closest('[data-go-filter]');
    if (el) openView(el);
  });

  els.chips.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    state.filter = btn.dataset.filter;
    render();
  });

  els.list.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.closest('li').dataset.id;

    if (btn.dataset.action === 'toggle') {
      toggleComplete(id);
      saveTasks();
      render();
    } else if (btn.dataset.action === 'edit') {
      startEdit(id);
    } else if (btn.dataset.action === 'delete') {
      // Two-step delete: the first click asks, the second click removes.
      // (window.confirm() is blocked inside the published viewer, so it is not used.)
      state.confirmDeleteId = id;
      render();
    } else if (btn.dataset.action === 'confirm-delete') {
      const index = state.tasks.findIndex((t) => t.id === id);
      if (index === -1) return;
      const task = state.tasks[index];
      if (state.editingId === id) {
        resetForm();
        closeForm();
      }
      deleteTask(id);
      state.confirmDeleteId = null;
      saveTasks();
      showUndo([{ task, index }], `Deleted "${task.title}"`);
      render();
    } else if (btn.dataset.action === 'cancel-delete') {
      state.confirmDeleteId = null;
      render();
    }
  });

  /* ---------- Undo ---------- */
  const UNDO_MS = 6000;

  function showUndo(removed, message) {
    clearTimeout(state.undo && state.undo.timer);
    const timer = setTimeout(hideUndo, UNDO_MS);
    state.undo = { removed, timer };
    els.toastText.textContent = `${message}.`;
    els.toast.hidden = false;
  }

  function hideUndo() {
    clearTimeout(state.undo && state.undo.timer);
    state.undo = null;
    els.toast.hidden = true;
  }

  function undoRemoval() {
    if (!state.undo) return;
    // Put each activity back where it was, starting with the lowest position.
    [...state.undo.removed]
      .sort((a, b) => a.index - b.index)
      .forEach(({ task, index }) => {
        state.tasks.splice(Math.min(index, state.tasks.length), 0, task);
      });
    saveTasks();
    hideUndo();
    render();
  }

  els.toastUndo.addEventListener('click', undoRemoval);

  function clearCompleted() {
    const removed = [];
    state.tasks.forEach((task, index) => {
      if (task.completed) removed.push({ task, index });
    });
    if (removed.length === 0) return;
    if (state.editingId && removed.some((r) => r.task.id === state.editingId)) {
      resetForm();
      closeForm();
    }
    state.tasks = state.tasks.filter((t) => !t.completed);
    saveTasks();
    showUndo(removed, `Cleared ${removed.length} completed ${removed.length === 1 ? 'activity' : 'activities'}`);
    render();
  }

  els.clearDoneBtn.addEventListener('click', clearCompleted);

  function renderClearDone() {
    const n = state.tasks.filter((t) => t.completed).length;
    els.clearDoneBtn.textContent = `Clear completed (${n})`;
    els.clearDoneBtn.disabled = n === 0;
  }

  /* ---------- Render: tabs & chips ---------- */
  function renderControls() {
    els.tabs.querySelectorAll('[data-horizon]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.horizon === state.horizon));
    });

    // The Month tab names the month being viewed, and the month picker shows when it is in use.
    const monthTabLabel = els.tabs.querySelector('[data-horizon="month"] .tab-label');
    if (monthTabLabel) monthTabLabel.textContent = monthName(state.month);
    // The month bar is always visible above the dashboard.
    const current = state.month === currentMonthKey();
    els.monthLabel.textContent = current ? `${monthNameOf(state.month)} (this month)` : monthNameOf(state.month);
    els.monthBack.hidden = current;
    els.monthPrev.setAttribute('aria-label', `Previous month: ${monthNameOf(shiftMonth(state.month, -1))}`);
    els.monthNext.setAttribute('aria-label', `Next month: ${monthNameOf(shiftMonth(state.month, 1))}`);

    // Tab badges show every activity in the view, matching the bars and stat cards.
    Object.keys(HORIZON_LABEL).forEach((h) => {
      const c = countsFor(h);
      const badge = els.tabs.querySelector(`[data-count="${h}"]`);
      if (badge) badge.textContent = c.total;
    });

    els.chips.querySelectorAll('[data-filter]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.filter === state.filter));
    });
  }

  /* ---------- Render: task list ---------- */
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  function taskHTML(t) {
    const status = statusOf(t);
    const isDone = status === 'completed';
    const prio = t.priority.charAt(0).toUpperCase() + t.priority.slice(1);
    const finished = isDone && t.completedAt
      ? `<span>Finished ${formatCompleted(t.completedAt)}</span>`
      : '';

    return `
      <li class="task is-${status} prio-${t.priority}" data-id="${esc(t.id)}">
        <div class="task-main">
          <h3 class="task-title">${esc(t.title)}</h3>
          <div class="task-meta">
            <span class="badge badge-${status}">${STATUS_LABEL[status]}</span>
            <span>📅 Due ${formatDate(t.dueDate)}</span>
            <span class="prio">${prio} priority</span>
            ${finished}
          </div>
          ${t.notes ? `<p class="task-notes">${esc(t.notes)}</p>` : ''}
        </div>
        <div class="task-actions">
          ${isDone
            ? `<button class="icon-btn done" data-action="toggle" aria-label="Completed. Mark as not done">✓ Completed</button>`
            : `<button class="icon-btn" data-action="toggle" aria-label="Mark as completed">Mark complete</button>`}
          ${state.confirmDeleteId === t.id
            ? `<button class="icon-btn confirm" data-action="confirm-delete">Confirm delete</button>
               <button class="icon-btn" data-action="cancel-delete">Keep</button>`
            : `<button class="icon-btn" data-action="edit">Edit</button>
               <button class="icon-btn danger" data-action="delete">Delete</button>`}
        </div>
      </li>`;
  }

  function renderList() {
    const items = visibleTasks();
    els.list.innerHTML = items.map(taskHTML).join('');
    els.empty.hidden = items.length > 0;
    els.resultCount.textContent = `${items.length} ${items.length === 1 ? 'activity' : 'activities'} shown.`;

    if (items.length === 0) {
      const what = state.filter === 'all' ? 'activities' : `${state.filter} activities`;
      els.empty.querySelector('p:last-child').textContent =
        `No ${what} in ${labelFor(state.horizon).toLowerCase()}.`;
    }
  }

  /* ---------- Render: dashboard ---------- */
  function pct(part, whole) {
    return whole ? Math.round((part / whole) * 100) : 0;
  }

  function renderDashboard() {
    // Stat cards: one per period plus overdue.
    const periodCards = ['today', 'week', 'month'].map((h) => {
      const c = countsFor(h);
      const p = pct(c.completed, c.total);
      const active = state.horizon === h && state.filter === 'all';
      return `
        <button type="button" class="stat-card${active ? ' is-active' : ''}" data-go-horizon="${h}"
                aria-label="Show ${labelFor(h)} activities">
          <div class="stat-label">${labelFor(h)}</div>
          <div class="stat-value">${c.completed}<span> / ${c.total} done</span></div>
          <div class="progress"><div style="width:${p}%"></div></div>
          <div class="stat-sub">${c.pending} pending · ${c.overdue} overdue</div>
        </button>`;
    });

    const all = countsFor('all');
    const overdueActive = state.filter === 'overdue';
    const overdueCard = `
      <button type="button" class="stat-card is-overdue${overdueActive ? ' is-active' : ''}" data-go-filter="overdue"
              aria-label="Show overdue activities">
        <div class="stat-label">Overdue</div>
        <div class="stat-value">${all.overdue}</div>
        <div class="progress"><div style="width:${pct(all.overdue, all.total)}%; background:var(--overdue)"></div></div>
        <div class="stat-sub">${all.overdue ? 'Needs attention' : 'Nothing overdue'}</div>
      </button>`;

    els.statCards.innerHTML = periodCards.join('') + overdueCard;

    // Overall ring.
    const overall = pct(all.completed, all.total);
    els.ring.style.strokeDasharray = `${RING_LENGTH}`;
    els.ring.style.strokeDashoffset = `${RING_LENGTH * (1 - overall / 100)}`;
    els.ringText.textContent = `${overall}%`;

    // Stacked bars per period.
    els.barChart.innerHTML = ['today', 'week', 'month', 'all'].map((h) => {
      const c = countsFor(h);
      const seg = (n) => (c.total ? (n / c.total) * 100 : 0);
      return `
        <button type="button" class="bar-row" data-go-horizon="${h}" aria-label="Show ${labelFor(h)} activities">
          <div class="bar-label">${labelFor(h)}</div>
          <div class="bar-track" title="${c.completed} completed, ${c.pending} pending, ${c.overdue} overdue">
            <span class="seg seg-completed" style="width:${seg(c.completed)}%"></span>
            <span class="seg seg-pending" style="width:${seg(c.pending)}%"></span>
            <span class="seg seg-overdue" style="width:${seg(c.overdue)}%"></span>
          </div>
          <div class="bar-num">${c.total}</div>
        </button>`;
    }).join('');
  }

  /* ---------- Render ---------- */
  function renderWelcome() {
    const show = state.tasks.length === 0 && !welcomeDismissed();
    els.welcome.hidden = !show;
  }

  function renderSummary() {
    const all = countsFor('all');
    const today = countsFor('today');
    if (all.total === 0) {
      // The welcome card already explains the empty state, so the summary stays blank here.
      els.summary.textContent = '';
      return;
    }
    const parts = [];
    parts.push(all.overdue ? `${all.overdue} overdue` : 'Nothing overdue');
    parts.push(`${today.pending + today.overdue} open today`);
    parts.push(`${pct(all.completed, all.total)}% done overall`);
    els.summary.textContent = parts.join(' · ');
  }

  function render() {
    renderWelcome();
    renderClearDone();
    renderControls();
    renderList();
    renderDashboard();
    renderSummary();
  }

  /* ---------- Init ---------- */
  // Another tab saved changes: reload so this tab never overwrites them.
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return;
    state.tasks = loadTasks();
    render();
  });

  els.todayLabel.textContent = new Date().toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  state.month = currentMonthKey();
  resetForm();
  render();

  // Refresh statuses periodically so tasks turn overdue at midnight without a reload.
  setInterval(render, 60 * 1000);

  // Offline support: cache the app shell when the site is served over http(s).
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
  }
})();
