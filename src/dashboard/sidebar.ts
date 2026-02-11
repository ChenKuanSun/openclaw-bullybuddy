interface SessionInfo {
  id: string;
  name: string;
  group: string;
  status: string;
  detailedState?: string;
  cwd: string;
  pid: number | null;
}

type SelectHandler = (sessionId: string) => void;
type SpawnHandler = (group: string) => void;
type KillHandler = (sessionId: string) => void;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') element.className = v;
      else element.setAttribute(k, v);
    }
  }
  for (const child of children) {
    element.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return element;
}

function stateLabel(state: string): string {
  switch (state) {
    case 'working': return 'working';
    case 'permission_needed': return 'needs input';
    case 'compacting': return 'compacting';
    case 'error': return 'error';
    case 'idle': return 'idle';
    case 'starting': return 'starting';
    case 'exited': return 'exited';
    default: return state;
  }
}

const GROUPS_KEY = 'bullybuddy:groups';

export function loadGroups(): string[] {
  try {
    const raw = localStorage.getItem(GROUPS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return ['default'];
}

export function saveGroups(groups: string[]): void {
  localStorage.setItem(GROUPS_KEY, JSON.stringify(groups));
}

export class Sidebar {
  private container: HTMLElement;
  private sessions: SessionInfo[] = [];
  private activeId: string | null = null;
  private collapsedGroups = new Set<string>();
  private onSelect: SelectHandler = () => {};
  private onSpawn: SpawnHandler = () => {};
  private onKill: KillHandler = () => {};

  constructor(container: HTMLElement) {
    this.container = container;
  }

  setOnSelect(fn: SelectHandler): void { this.onSelect = fn; }
  setOnSpawn(fn: SpawnHandler): void { this.onSpawn = fn; }
  setOnKill(fn: KillHandler): void { this.onKill = fn; }

  setActive(id: string | null): void {
    this.activeId = id;
    this.render();
  }

  update(sessions: SessionInfo[]): void {
    this.sessions = sessions;
    this.render();
  }

  addSession(session: SessionInfo): void {
    const idx = this.sessions.findIndex((s) => s.id === session.id);
    if (idx >= 0) this.sessions[idx] = session;
    else this.sessions.push(session);
    this.render();
  }

  removeSession(id: string): void {
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.activeId === id) this.activeId = null;
    this.render();
  }

  markExited(id: string): void {
    const s = this.sessions.find((s) => s.id === id);
    if (s) { s.status = 'exited'; s.pid = null; this.render(); }
  }

  updateDetailedState(id: string, detailedState: string): void {
    const s = this.sessions.find((s) => s.id === id);
    if (s) { s.detailedState = detailedState; this.render(); }
  }

  // Full DOM re-render: intentional for simplicity — session list is small enough that
  // diffing overhead isn't warranted.
  private render(): void {
    this.container.replaceChildren();

    // ── Spawn area: button + group selector ──
    const actions = el('div', { className: 'sidebar-actions' });
    const spawnRow = el('div', { className: 'sidebar-spawn-row' });

    const groupSelect = el('select', { className: 'sidebar-group-select' });
    const definedGroups = loadGroups();
    // Merge defined groups with any groups that exist on sessions
    const allGroupNames = new Set(definedGroups);
    for (const s of this.sessions) allGroupNames.add(s.group);
    for (const g of allGroupNames) {
      const opt = el('option');
      opt.value = g;
      opt.textContent = g;
      groupSelect.append(opt);
    }

    const spawnBtn = el('button', { className: 'btn btn-primary' }, '+ New');
    spawnBtn.addEventListener('click', () => this.onSpawn(groupSelect.value));

    spawnRow.append(groupSelect, spawnBtn);
    actions.append(spawnRow);
    this.container.append(actions);

    if (this.sessions.length === 0) {
      const empty = el('div');
      empty.style.cssText = 'padding: 16px 12px; color: var(--text-muted); font-size: 13px;';
      empty.textContent = 'No sessions yet. Spawn one to get started.';
      this.container.append(empty);
      return;
    }

    // ── Group sessions ──
    const groups = new Map<string, SessionInfo[]>();
    for (const s of this.sessions) {
      if (!groups.has(s.group)) groups.set(s.group, []);
      groups.get(s.group)!.push(s);
    }

    for (const [group, sessions] of groups) {
      const groupEl = el('div', { className: 'sidebar-group' });
      const collapsed = this.collapsedGroups.has(group);

      const chevron = el('span', { className: 'sidebar-group-chevron' });
      chevron.textContent = collapsed ? '\u25B6' : '\u25BC';

      const header = el('div', { className: 'sidebar-group-header' },
        chevron,
        group,
        el('span', { className: 'sidebar-group-count' }, String(sessions.length)),
      );
      header.addEventListener('click', () => {
        if (this.collapsedGroups.has(group)) {
          this.collapsedGroups.delete(group);
        } else {
          this.collapsedGroups.add(group);
        }
        this.render();
      });
      groupEl.append(header);

      if (!collapsed) {
        for (const s of sessions) {
          const stateClass = s.detailedState ?? (s.status === 'running' ? 'starting' : 'exited');
          const item = el('div', {
            className: `session-item ${s.id === this.activeId ? 'active' : ''}`,
            'data-id': s.id,
          },
            el('div', { className: `session-status state-${stateClass}` }),
            el('span', { className: 'session-name' }, s.name),
            s.detailedState && s.status === 'running'
              ? el('span', { className: `session-state session-state-${stateClass}` }, stateLabel(stateClass))
              : el('span', { className: 'session-id' }, s.id),
          );

          // Exited sessions are not interactive (no terminal to attach to)
          if (s.status !== 'exited') {
            item.addEventListener('click', () => this.onSelect(s.id));
          } else {
            item.classList.add('exited');
          }
          item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.onKill(s.id);
          });

          groupEl.append(item);
        }
      }

      this.container.append(groupEl);
    }
  }
}
