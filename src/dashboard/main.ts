import '@xterm/xterm/css/xterm.css';
import { WsClient } from './ws-client.js';
import { Sidebar, loadGroups, saveGroups } from './sidebar.js';
import { SessionPanel } from './session-panel.js';
import { LobsterScene } from './lobster-scene.js';

// ── Auth token (from URL query parameter, persisted in sessionStorage) ──────

const urlParams = new URLSearchParams(location.search);
const TOKEN = urlParams.get('token') ?? sessionStorage.getItem('bb:token') ?? '';
if (TOKEN) {
  sessionStorage.setItem('bb:token', TOKEN);
  // Clean token from URL bar to avoid leaking in bookmarks/history
  if (urlParams.has('token')) {
    urlParams.delete('token');
    const clean = urlParams.toString();
    const newUrl = location.pathname + (clean ? `?${clean}` : '') + location.hash;
    history.replaceState(null, '', newUrl);
  }
}

function authedFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (TOKEN) headers.set('Authorization', `Bearer ${TOKEN}`);
  return fetch(url, { ...init, headers });
}

// ── WebSocket ────────────────────────────────────────────────────────────────

const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsTokenParam = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '';
const ws = new WsClient(`${wsProto}//${location.host}/ws${wsTokenParam}`);

// ── DOM references ───────────────────────────────────────────────────────────

const hudStatus = document.getElementById('hud-status')!;
const hudStatus3d = document.getElementById('hud-status-3d')!;
const hudSpawn = document.getElementById('hud-spawn')!;
const hudBackDash = document.getElementById('hud-back-dash')!;
const hudHint = document.getElementById('hud-hint')!;
const disconnectOverlay = document.getElementById('disconnect-overlay')!;

const world = document.getElementById('world')!;

const drawer = document.getElementById('terminal-drawer')!;
const drawerClose = document.getElementById('drawer-close')!;
const drawerTitle = document.getElementById('drawer-title')!;
const drawerActions = document.getElementById('drawer-actions')!;

const dashboard = document.getElementById('dashboard')!;
const dashLobster = document.getElementById('dash-lobster')!;
const dashStats = document.getElementById('dash-stats')!;
const dashTermBack = document.getElementById('dash-terminal-back')!;
const dashTermTitle = document.getElementById('dash-terminal-title')!;
const dashTermActions = document.getElementById('dash-terminal-actions')!;

// ── Session data cache ──────────────────────────────────────────────────────

const sessionNames = new Map<string, string>();
let latestSessions: any[] = [];

function sessionDisplayName(id: string): string {
  return sessionNames.get(id) ?? id.slice(0, 8);
}

// ── 3D Scene (lazy — only created when user navigates to lobster view) ──────

let lobsterScene: LobsterScene | null = null;

function ensureLobsterScene(): LobsterScene {
  if (!lobsterScene) {
    lobsterScene = new LobsterScene(
      document.getElementById('world-canvas')!,
      document.getElementById('world-labels')!,
      ws,
    );
    lobsterScene.onLobsterClick = (sessionId) => openDrawer(sessionId);
    lobsterScene.start();
    // Feed sessions already received before scene was created
    if (latestSessions.length > 0) {
      lobsterScene.initSessions(latestSessions);
    }
  }
  return lobsterScene;
}

// ── Terminal panels (drawer for 3D, embedded for dashboard) ──────────────────

const drawerPanel = new SessionPanel(
  document.getElementById('drawer-terminal')!,
  ws,
  document.getElementById('drawer-toolbar')!,
);

const dashPanel = new SessionPanel(
  document.getElementById('dash-terminal-container')!,
  ws,
  document.getElementById('dash-terminal-toolbar')!,
);

// ── Sidebar (dashboard only) ─────────────────────────────────────────────────

const sidebar = new Sidebar(document.getElementById('sidebar')!);

// ── HUD: Spawn session (3D view) ────────────────────────────────────────────

let spawning = false;

hudSpawn.addEventListener('click', async () => {
  if (spawning) return;
  spawning = true;
  hudSpawn.classList.add('spawning');
  const prevText = hudSpawn.textContent;
  hudSpawn.textContent = 'Spawning...';

  try {
    await authedFetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: spawnBody(),
    });
  } catch {
    // Will be caught by disconnect overlay
  } finally {
    spawning = false;
    hudSpawn.classList.remove('spawning');
    hudSpawn.textContent = prevText;
  }
});

// ── View switching: Dashboard (primary) ↔ 3D World (secondary) ──────────────

function showWorld(): void {
  ensureLobsterScene();
  world.classList.remove('view-hidden');
  dashboard.classList.add('view-hidden');
  history.replaceState(null, '', '/lobster');
}

function hideWorld(): void {
  closeDrawer();
  world.classList.add('view-hidden');
  dashboard.classList.remove('view-hidden');
  history.replaceState(null, '', '/');
}

dashLobster.addEventListener('click', () => showWorld());
hudBackDash.addEventListener('click', () => hideWorld());

// ── 3D: Lobster click → open terminal drawer ────────────────────────────────

async function openDrawer(sessionId: string): Promise<void> {
  drawerTitle.textContent = sessionDisplayName(sessionId);
  drawer.classList.remove('drawer-hidden');
  drawer.classList.add('drawer-loading');

  try {
    const res = await authedFetch(`/api/sessions/${sessionId}`);
    const json = await res.json();

    if (json.data?.name) {
      sessionNames.set(sessionId, json.data.name);
      drawerTitle.textContent = json.data.name;
    }

    drawerPanel.attach(sessionId);
    renderDrawerActions(sessionId, json.data?.status ?? 'running');
  } catch {
    drawerTitle.textContent = 'Connection error';
  } finally {
    drawer.classList.remove('drawer-loading');
  }
}

function closeDrawer(): void {
  drawer.classList.add('drawer-hidden');
  drawerPanel.detach();
  drawerTitle.textContent = 'Session';
  drawerActions.replaceChildren();
}

drawerClose.addEventListener('click', closeDrawer);

function renderDrawerActions(sessionId: string, status: string): void {
  drawerActions.replaceChildren();
  if (status === 'running') {
    const killBtn = document.createElement('button');
    killBtn.className = 'hud-btn btn-kill';
    killBtn.textContent = 'Kill';
    killBtn.addEventListener('click', async () => {
      await authedFetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
      sidebar.removeSession(sessionId);
      closeDrawer();
    });
    drawerActions.append(killBtn);
  }
}

// ── Dashboard: sidebar interactions ──────────────────────────────────────────

sidebar.setOnSelect(async (id) => {
  sidebar.setActive(id);
  dashTermTitle.textContent = sessionDisplayName(id);

  const res = await authedFetch(`/api/sessions/${id}`);
  const json = await res.json();

  if (json.data?.name) {
    sessionNames.set(id, json.data.name);
    dashTermTitle.textContent = json.data.name;
  }

  dashPanel.attach(id);
  renderDashActions(id, json.data?.status ?? 'running');

  dashboard.classList.add('show-terminal');
});

sidebar.setOnSpawn(async (group) => {
  await authedFetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: spawnBody(group),
  });
});

dashTermBack.addEventListener('click', () => {
  dashPanel.detach();
  sidebar.setActive(null);
  dashTermTitle.textContent = 'Select a session';
  dashTermActions.replaceChildren();
  dashboard.classList.remove('show-terminal');
});

sidebar.setOnKill(async (id) => {
  await authedFetch(`/api/sessions/${id}`, { method: 'DELETE' });
  sidebar.removeSession(id);
  if (dashPanel.activeSessionId === id) {
    dashPanel.detach();
    dashTermTitle.textContent = 'Select a session';
    dashTermActions.replaceChildren();
    dashboard.classList.remove('show-terminal');
  }
});

function renderDashActions(sessionId: string, status: string): void {
  dashTermActions.replaceChildren();
  if (status === 'running') {
    const killBtn = document.createElement('button');
    killBtn.className = 'btn btn-danger';
    killBtn.textContent = 'Kill';
    killBtn.addEventListener('click', async () => {
      await authedFetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
      sidebar.removeSession(sessionId);
      dashPanel.detach();
      dashTermTitle.textContent = 'Select a session';
      dashTermActions.replaceChildren();
    });
    dashTermActions.append(killBtn);
  }
}

// ── WebSocket events ─────────────────────────────────────────────────────────

function setConnectionStatus(text: string, className: string): void {
  hudStatus.textContent = text;
  hudStatus.className = className;
  hudStatus3d.textContent = text;
  hudStatus3d.className = className;
}

ws.on('_connected', () => {
  setConnectionStatus('connected', 'connected');
  disconnectOverlay.classList.add('overlay-hidden');
  // Re-subscribe active terminal panels after reconnect
  drawerPanel.resubscribe();
  dashPanel.resubscribe();
});

ws.on('_disconnected', () => {
  setConnectionStatus('reconnecting...', 'reconnecting');
  disconnectOverlay.classList.remove('overlay-hidden');
});

ws.on('sessions', (msg) => {
  latestSessions = msg.sessions;
  for (const s of msg.sessions) {
    sessionNames.set(s.id, s.name);
  }

  sidebar.update(msg.sessions);
  dashStats.textContent = `${msg.sessions.length} session(s)`;

  updateHint(msg.sessions.length);
});

ws.on('session:created', (msg) => {
  sessionNames.set(msg.session.id, msg.session.name);
  latestSessions.push(msg.session);
  sidebar.addSession(msg.session);
  dashStats.textContent = `${latestSessions.length} session(s)`;
  updateHint(latestSessions.length);
});

ws.on('session:exited', (msg) => {
  const cached = latestSessions.find((s: any) => s.id === msg.sessionId);
  if (cached) { cached.status = 'exited'; cached.pid = null; }
  sidebar.markExited(msg.sessionId);
  if (drawerPanel.activeSessionId === msg.sessionId) {
    drawerActions.replaceChildren();
    const badge = document.createElement('span');
    badge.className = 'exit-badge';
    badge.textContent = 'exited';
    drawerActions.append(badge);
  }
});

ws.on('session:stateChanged', (msg) => {
  const cached = latestSessions.find((s: any) => s.id === msg.sessionId);
  if (cached) cached.detailedState = msg.detailedState;
  sidebar.updateDetailedState(msg.sessionId, msg.detailedState);
});

// ── Settings: default cwd ────────────────────────────────────────────────────

const STORAGE_KEY = 'bullybuddy:defaultCwd';

function getDefaultCwd(): string | undefined {
  return localStorage.getItem(STORAGE_KEY) || undefined;
}

function setDefaultCwd(path: string | null): void {
  if (path) {
    localStorage.setItem(STORAGE_KEY, path);
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
  settingsCwdInput.value = path ?? '';
}

function spawnBody(group?: string): string {
  const cwd = getDefaultCwd();
  const body: Record<string, string> = {};
  if (cwd) body.cwd = cwd;
  if (group) body.group = group;
  return JSON.stringify(body);
}

// ── Settings modal ──────────────────────────────────────────────────────────

const settingsModal = document.getElementById('settings-modal')!;
const settingsBackdrop = document.getElementById('settings-backdrop')!;
const settingsClose = document.getElementById('settings-close')!;
const dashSettings = document.getElementById('dash-settings')!;
const settingsCwdInput = document.getElementById('settings-cwd') as HTMLInputElement;
const settingsBrowse = document.getElementById('settings-browse')!;
const settingsClearCwd = document.getElementById('settings-clear-cwd')!;

const fileBrowser = document.getElementById('file-browser')!;
const browserUp = document.getElementById('browser-up')!;
const browserPath = document.getElementById('browser-path')!;
const browserSelect = document.getElementById('browser-select')!;
const browserList = document.getElementById('browser-list')!;

const settingsGroupsList = document.getElementById('settings-groups-list')!;
const settingsGroupInput = document.getElementById('settings-group-input') as HTMLInputElement;
const settingsGroupAdd = document.getElementById('settings-group-add')!;

function renderGroupsList(): void {
  settingsGroupsList.replaceChildren();
  const groups = loadGroups();
  for (const g of groups) {
    const row = document.createElement('div');
    row.className = 'settings-group-item';

    const name = document.createElement('span');
    name.className = 'settings-group-name';
    name.textContent = g;
    row.append(name);

    if (g !== 'default') {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn btn-danger settings-group-remove';
      removeBtn.textContent = '\u2715';
      removeBtn.addEventListener('click', () => {
        const updated = loadGroups().filter((x) => x !== g);
        saveGroups(updated);
        renderGroupsList();
      });
      row.append(removeBtn);
    }

    settingsGroupsList.append(row);
  }
}

function addGroup(): void {
  const name = settingsGroupInput.value.trim();
  if (!name) return;
  const groups = loadGroups();
  if (!groups.includes(name)) {
    groups.push(name);
    saveGroups(groups);
  }
  settingsGroupInput.value = '';
  renderGroupsList();
}

settingsGroupAdd.addEventListener('click', () => addGroup());
settingsGroupInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addGroup();
});

let currentBrowsePath = '';

function openSettings(): void {
  settingsCwdInput.value = getDefaultCwd() ?? '';
  renderGroupsList();
  settingsModal.classList.remove('modal-hidden');
  fileBrowser.classList.add('browser-hidden');
}

function closeSettings(): void {
  settingsModal.classList.add('modal-hidden');
}

dashSettings.addEventListener('click', () => openSettings());
settingsClose.addEventListener('click', () => closeSettings());
settingsBackdrop.addEventListener('click', () => closeSettings());

settingsClearCwd.addEventListener('click', () => {
  setDefaultCwd(null);
  fileBrowser.classList.add('browser-hidden');
});

settingsBrowse.addEventListener('click', () => {
  fileBrowser.classList.remove('browser-hidden');
  browseTo(getDefaultCwd() ?? '');
});

async function browseTo(path: string): Promise<void> {
  try {
    const url = `/api/browse?path=${encodeURIComponent(path)}`;
    const res = await authedFetch(url);
    const data = await res.json();

    if (!data.ok) {
      browserList.replaceChildren();
      const errEl = document.createElement('div');
      errEl.className = 'browser-empty';
      errEl.textContent = data.error;
      browserList.append(errEl);
      return;
    }

    currentBrowsePath = data.data.path;
    browserPath.textContent = data.data.path;

    browserList.replaceChildren();
    const dirs: string[] = data.data.dirs;

    if (dirs.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'browser-empty';
      empty.textContent = 'No subdirectories';
      browserList.append(empty);
    } else {
      for (const dir of dirs) {
        const item = document.createElement('div');
        item.className = 'browser-dir';

        const icon = document.createElement('span');
        icon.className = 'browser-dir-icon';
        icon.textContent = '\u{1F4C1}';

        item.append(icon, dir);
        item.addEventListener('click', () => browseTo(`${currentBrowsePath}/${dir}`));
        browserList.append(item);
      }
    }
  } catch {
    browserList.replaceChildren();
    const errEl = document.createElement('div');
    errEl.className = 'browser-empty';
    errEl.textContent = 'Failed to load directory';
    browserList.append(errEl);
  }
}

browserUp.addEventListener('click', () => {
  const parent = currentBrowsePath.replace(/\/[^/]+$/, '') || '/';
  browseTo(parent);
});

browserSelect.addEventListener('click', () => {
  setDefaultCwd(currentBrowsePath);
  fileBrowser.classList.add('browser-hidden');
});

// ── Hint management ─────────────────────────────────────────────────────────

function updateHint(sessionCount: number): void {
  if (sessionCount > 0) {
    hudHint.classList.add('hint-hidden');
  } else {
    hudHint.classList.remove('hint-hidden');
  }
}

// ── Init ─────────────────────────────────────────────────────────────────────

ws.connect();

// Route: /lobster shows 3D world, everything else shows dashboard
if (location.pathname === '/lobster') {
  showWorld();
}
