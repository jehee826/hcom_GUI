import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { ProjectManager } from '../runtime/index.ts';
import type { ProjectEventRecord } from '../store/index.ts';
import { runCliDiagnostics, type CliDiagnostics } from './diagnostics.ts';

export interface GuiServerOptions {
  readonly manager: ProjectManager;
  readonly appVersion: string;
  readonly staticDir?: string;
  readonly port?: number;
  readonly token?: string;
  readonly codexCommand?: string;
  readonly getDiagnostics?: () => CliDiagnostics;
}

export interface GuiServerHandle {
  readonly server: Server;
  readonly port: number;
  readonly baseUrl: string;
  readonly token: string;
  close(): Promise<void>;
}

function safeTokenEqual(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin || origin === 'null') return true;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
  } catch {
    return false;
  }
}

function statusCodeForError(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (/등록되지 않은|찾을 수 없습니다/.test(message)) return 404;
  if (/이미 같은 Git 저장소|진행 중인/.test(message)) return 409;
  if (/다른 프로젝트|다른 Git 저장소|재사용할 수 없습니다|프로젝트 밖/.test(message)) return 403;
  if (/필요합니다|비어 있습니다|절대 경로|상대 경로|유효하지 않은/.test(message)) return 400;
  return 500;
}

function sendError(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  res.status(statusCodeForError(error)).json({ error: message });
}

function paramString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function queryString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseAfterSeq(req: Request): number {
  const raw = req.header('last-event-id') ?? queryString(req.query.afterSeq) ?? '0';
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export async function startGuiServer(options: GuiServerOptions): Promise<GuiServerHandle> {
  const app = express();
  const token = options.token ?? randomBytes(24).toString('hex');
  const manager = options.manager;
  const diagnostics = options.getDiagnostics ?? (() => runCliDiagnostics(options.codexCommand));
  const sseClients = new Set<Response>();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.use((_req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'none'",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  // 모든 API는 루프백 Origin 검증과 세션 토큰 인증을 요구한다.
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!isAllowedOrigin(req.header('origin'))) {
      res.status(403).json({ error: '허용되지 않은 Origin 요청입니다.' });
      return;
    }
    const headerToken = req.header('x-hcom-token')
      ?? (req.header('authorization')?.startsWith('Bearer ') ? req.header('authorization')!.slice(7) : undefined);
    const isSse = req.method === 'GET' && /^\/projects\/[^/]+\/events$/.test(req.path);
    const supplied = headerToken ?? (isSse ? queryString(req.query.token) : undefined);
    if (!safeTokenEqual(supplied, token)) {
      res.status(401).json({ error: '인증 토큰이 유효하지 않습니다.' });
      return;
    }
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, version: options.appVersion, dataDir: manager.dataDir });
  });

  app.get('/api/diagnostics', (_req, res) => {
    res.json(diagnostics());
  });

  app.get('/api/projects', (_req, res) => {
    try {
      res.json({
        projects: manager.listProjects(),
        selectedProjectId: manager.getSelectedProjectId(),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/projects', (req, res) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
      const folderPath = typeof body.folderPath === 'string' ? body.folderPath.trim() : '';
      const name = typeof body.name === 'string' ? body.name.trim() : undefined;
      if (!folderPath) {
        res.status(400).json({ error: '프로젝트 폴더 경로가 필요합니다.' });
        return;
      }
      const snapshot = manager.registerProject(folderPath, name ? { name } : undefined);
      res.status(201).json({ snapshot });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/projects/:projectId/select', (req, res) => {
    try {
      const snapshot = manager.selectProject(paramString(req.params.projectId));
      res.json({ snapshot });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/projects/:projectId', async (req, res) => {
    try {
      const projectId = paramString(req.params.projectId);
      const snapshot = manager.getProjectSnapshot(projectId);
      const requests = manager.listRequests(projectId);
      const delegations = manager.listDelegations(projectId);
      const events = manager.listProjectEvents(projectId, 0);
      const hcomParticipants = await manager.listProjectHcomParticipants(projectId).catch(() => []);
      res.json({
        snapshot,
        requests,
        delegations,
        hcomParticipants,
        latestSeq: events.at(-1)?.seq ?? 0,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/projects/:projectId/start', async (req, res) => {
    try {
      const snapshot = await manager.startProject(paramString(req.params.projectId));
      res.json({ snapshot });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/projects/:projectId/stop', async (req, res) => {
    try {
      const projectId = paramString(req.params.projectId);
      await manager.shutdownProject(projectId);
      res.json({ snapshot: manager.getProjectSnapshot(projectId) });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/projects/:projectId/workers', async (req, res) => {
    try {
      const projectId = paramString(req.params.projectId);
      const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const requestKey = typeof body.requestKey === 'string' ? body.requestKey.trim() : '';
      const cwd = typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : undefined;
      const start = typeof body.start === 'boolean' ? body.start : true;
      const worker = await manager.addWorker(projectId, { name, requestKey, cwd, start });
      res.status(201).json({ worker });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/projects/:projectId/workers/:workerId/start', async (req, res) => {
    try {
      const worker = await manager.startWorker(paramString(req.params.projectId), paramString(req.params.workerId));
      res.json({ worker });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/projects/:projectId/workers/:workerId/stop', async (req, res) => {
    try {
      const worker = await manager.stopWorker(paramString(req.params.projectId), paramString(req.params.workerId));
      res.json({ worker });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/projects/:projectId/worktree', async (req, res) => {
    try {
      const projectId = paramString(req.params.projectId);
      const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
      const worktreePath = typeof body.worktreePath === 'string' ? body.worktreePath.trim() : '';
      const target = body.target === 'codex'
        ? 'codex' as const
        : body.target && typeof body.target === 'object' && typeof (body.target as Record<string, unknown>).workerId === 'string'
          ? { workerId: String((body.target as Record<string, unknown>).workerId) }
          : undefined;
      if (!target || !worktreePath) {
        res.status(400).json({ error: 'target과 worktreePath가 필요합니다.' });
        return;
      }
      const snapshot = await manager.switchWorktree(projectId, target, worktreePath);
      res.json({ snapshot });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/api/projects/:projectId/requests', (req, res) => {
    try {
      const projectId = paramString(req.params.projectId);
      const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
      const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      if (!requestId || !prompt) {
        res.status(400).json({ error: 'requestId와 prompt가 필요합니다.' });
        return;
      }
      const existing = manager.getRequest(projectId, requestId);
      if (existing) {
        res.status(200).json({ request: existing, deduplicated: true });
        return;
      }
      // submitRequest가 동기적으로 acceptRequest를 기록한 뒤 비동기 턴을 실행한다.
      const runPromise = manager.submitRequest(projectId, requestId, prompt);
      runPromise.catch(() => {});
      const accepted = manager.getRequest(projectId, requestId);
      res.status(202).json({ request: accepted, deduplicated: false });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/projects/:projectId/requests/:requestId', (req, res) => {
    try {
      const projectId = paramString(req.params.projectId);
      const requestId = paramString(req.params.requestId);
      const request = manager.getRequest(projectId, requestId);
      if (!request) {
        res.status(404).json({ error: '요청을 찾을 수 없습니다.' });
        return;
      }
      const delegations = manager.listDelegations(projectId, requestId);
      res.json({ request, delegations });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.patch('/api/projects/:projectId/handoff', (req, res) => {
    try {
      const projectId = paramString(req.params.projectId);
      const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
      const handoff = manager.updateHandoff(projectId, {
        ...(typeof body.goal === 'string' ? { goal: body.goal } : {}),
        ...(Array.isArray(body.designDocs) ? { designDocs: body.designDocs.filter((d): d is string => typeof d === 'string') } : {}),
        ...(typeof body.testCommand === 'string' || body.testCommand === null ? { testCommand: body.testCommand } : {}),
        ...(typeof body.testResult === 'string' ? { testResult: body.testResult } : {}),
        ...(typeof body.nextSteps === 'string' ? { nextSteps: body.nextSteps } : {}),
      });
      res.json({ handoff });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.get('/api/projects/:projectId/events', (req, res) => {
    try {
      const projectId = paramString(req.params.projectId);
      manager.getProjectSnapshot(projectId);
      const afterSeq = parseAfterSeq(req);

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      sseClients.add(res);

      let lastSent = afterSeq;
      const writeEvent = (event: ProjectEventRecord): void => {
        if (event.projectId !== projectId || event.seq <= lastSent) return;
        lastSent = event.seq;
        res.write(`id: ${event.seq}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`);
      };

      const buffered: ProjectEventRecord[] = [];
      let replaying = true;
      const unsubscribe = manager.subscribeEvents(event => {
        if (event.projectId !== projectId) return;
        if (replaying) buffered.push(event);
        else writeEvent(event);
      });

      for (const past of manager.listProjectEvents(projectId, afterSeq)) {
        writeEvent(past);
      }
      replaying = false;
      for (const live of buffered) {
        writeEvent(live);
      }

      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(': keepalive\n\n');
      }, 25_000);
      heartbeat.unref();

      req.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
        sseClients.delete(res);
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  if (options.staticDir) {
    app.use(express.static(options.staticDir));
  }

  const server = await new Promise<Server>((resolve, reject) => {
    const srv = app.listen(options.port ?? 0, '127.0.0.1', () => resolve(srv));
    srv.once('error', reject);
  });

  const address = server.address() as AddressInfo;
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    server,
    port,
    baseUrl,
    token,
    async close(): Promise<void> {
      for (const client of sseClients) {
        try { client.end(); } catch {}
      }
      sseClients.clear();
      await new Promise<void>((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()));
      });
    },
  };
}
