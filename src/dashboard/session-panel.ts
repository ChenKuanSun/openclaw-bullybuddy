import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { WsClient } from './ws-client.js';

function isMobile(): boolean {
  return window.innerWidth < 768 || ('ontouchstart' in window && window.innerWidth < 1024);
}

const TOOLBAR_BUTTONS = [
  { label: 'Paste', action: 'paste' },
  { label: '^C', action: '\x03' },
  { label: '^D', action: '\x04' },
  { label: '^Z', action: '\x1a' },
  { label: 'Up', action: '\x1b[A' },
  { label: 'Down', action: '\x1b[B' },
  { label: 'Tab', action: '\t' },
  { label: 'Esc', action: '\x1b' },
] as const;

export class SessionPanel {
  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private container: HTMLElement;
  private toolbarEl: HTMLElement;
  private ws: WsClient;
  private currentId: string | null = null;
  private unsubOutput: (() => void) | null = null;
  private unsubScrollback: (() => void) | null = null;
  private unsubExit: (() => void) | null = null;
  private termDisposables: { dispose(): void }[] = [];
  private resizeObserver: ResizeObserver;
  // Write batching — coalesce rapid WS output into fewer terminal.write() calls
  private writeBuffer = '';
  private writeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(container: HTMLElement, ws: WsClient, toolbarEl?: HTMLElement) {
    this.container = container;
    this.toolbarEl = toolbarEl ?? document.getElementById('terminal-toolbar')!;
    this.ws = ws;
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.buildToolbar();
  }

  private buildToolbar(): void {
    this.toolbarEl.replaceChildren();
    for (const btn of TOOLBAR_BUTTONS) {
      const el = document.createElement('button');
      el.className = 'tb-btn';
      el.textContent = btn.label;
      el.addEventListener('click', (e) => {
        e.preventDefault();
        if (btn.action === 'paste') {
          this.handlePaste();
        } else {
          this.sendInput(btn.action);
        }
      });
      this.toolbarEl.append(el);
    }
  }

  private async handlePaste(): Promise<void> {
    if (!this.currentId) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) this.sendInput(text);
    } catch {
      // Clipboard API denied — try execCommand fallback via a hidden input
      const input = document.createElement('textarea');
      input.style.cssText = 'position:fixed;opacity:0;left:-9999px';
      document.body.append(input);
      input.focus();
      document.execCommand('paste');
      const text = input.value;
      input.remove();
      if (text) this.sendInput(text);
    }
  }

  private sendInput(data: string): void {
    if (!this.currentId) return;
    this.ws.send({ type: 'input', sessionId: this.currentId, data });
    this.terminal?.focus();
  }

  /** Buffer output and flush once per frame to avoid excessive terminal re-renders */
  private scheduleWrite(data: string): void {
    this.writeBuffer += data;
    if (!this.writeTimer) {
      this.writeTimer = setTimeout(() => this.flushWrite(), 16);
    }
  }

  private flushWrite(): void {
    this.writeTimer = null;
    if (this.writeBuffer && this.terminal) {
      this.terminal.write(this.writeBuffer);
      this.writeBuffer = '';
    }
  }

  attach(sessionId: string): void {
    this.detach();
    this.currentId = sessionId;

    const mobile = isMobile();
    this.terminal = new Terminal({
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
        selectionBackground: '#264f78',
        black: '#484f58',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39d353',
        white: '#b1bac4',
      },
      fontSize: mobile ? 9 : 13,
      fontFamily: "'SF Mono', SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace",
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new WebLinksAddon());

    this.terminal.open(this.container);
    this.fitAddon.fit();
    this.resizeObserver.observe(this.container);

    // Subscribe with actual terminal dimensions so the server can resize
    // the PTY BEFORE sending scrollback. This ensures:
    // 1. PTY gets SIGWINCH → TUI app redraws at correct column width
    // 2. Scrollback arrives (may be garbled from old size, pushed to history)
    // 3. TUI's SIGWINCH redraw paints a clean screen at new dimensions
    const { cols, rows } = this.terminal;
    this.ws.send({ type: 'subscribe', sessionId, cols, rows });

    // Scrollback delivered via WS (after server-side resize).
    // Write it (pushes garbled old-size data into scroll history),
    // then immediately clear the visible screen. The TUI app's
    // SIGWINCH redraw will paint a clean screen at the new size.
    this.unsubScrollback = this.ws.on('scrollback', (msg) => {
      if (msg.sessionId === sessionId && msg.data) {
        this.terminal?.write(msg.data);
        this.terminal?.write('\x1b[2J\x1b[H');
      }
    });

    this.unsubOutput = this.ws.on('output', (msg) => {
      if (msg.sessionId === sessionId) {
        this.scheduleWrite(msg.data);
      }
    });

    this.unsubExit = this.ws.on('session:exited', (msg) => {
      if (msg.sessionId === sessionId) {
        this.terminal?.write('\r\n\x1b[90m[Session exited]\x1b[0m\r\n');
      }
    });

    // Forward keyboard input
    this.termDisposables.push(
      this.terminal.onData((data) => {
        this.ws.send({ type: 'input', sessionId, data });
      }),
    );

    // Forward resize
    this.termDisposables.push(
      this.terminal.onResize(({ cols, rows }) => {
        this.ws.send({ type: 'resize', sessionId, cols, rows });
      }),
    );

    this.terminal.focus();
  }

  detach(): void {
    if (this.currentId) {
      this.ws.send({ type: 'unsubscribe', sessionId: this.currentId });
    }
    // Flush any buffered writes before disposing terminal
    if (this.writeTimer) { clearTimeout(this.writeTimer); this.writeTimer = null; }
    if (this.writeBuffer && this.terminal) {
      this.terminal.write(this.writeBuffer);
    }
    this.writeBuffer = '';
    this.unsubOutput?.();
    this.unsubScrollback?.();
    this.unsubExit?.();
    for (const d of this.termDisposables) d.dispose();
    this.termDisposables.length = 0;
    this.resizeObserver.disconnect();
    this.terminal?.dispose();
    this.terminal = null;
    this.fitAddon = null;
    this.currentId = null;
    this.container.replaceChildren();
  }

  resubscribe(): void {
    if (!this.currentId || !this.terminal) return;
    const { cols, rows } = this.terminal;
    this.ws.send({ type: 'subscribe', sessionId: this.currentId, cols, rows });
  }

  fit(): void {
    this.fitAddon?.fit();
  }

  get activeSessionId(): string | null {
    return this.currentId;
  }
}
