import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { parse as parseUrl } from 'node:url';
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';

/*
 * A minimal HTTP server implementing an AI agent backend. The server exposes
 * endpoints compatible with the client in client/src/App.tsx. It does not
 * depend on any external npm packages – only Node's built‑in modules – so it
 * can run in restricted environments where package installation is not
 * allowed.
 *
 * Endpoints:
 *   POST /api/chat        Send a user message and start a new run. Returns
 *                          JSON { runId, threadId }.
 *   GET /api/stream/:id   Server‑Sent Events (SSE) stream for run events.
 *   GET /api/health       Returns { status: 'ok' }.
 *
 * The server keeps all run state in memory. For a production deployment you
 * should store runs and threads in a persistent database. Responses are
 * stubbed – when Codex/OpenAI integration is not configured the server
 * simply echoes back the user's input.
 */

// In‑memory storage for run and thread state.
const runs = new Map();
const threads = new Map();

// Helper to send JSON responses with proper CORS headers.
function sendJson(res, statusCode, data) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(data));
}

// Helper to generate SSE events. Accepts a response object and pushes an
// event (JSON serialised) to all clients subscribed to the run.
function pushEvent(run, ev) {
  run.events.push(ev);
  const payload = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of run.clients) {
    res.write(payload);
  }
}

// Simple echo agent. In the absence of a connection to the OpenAI API this
// function takes the user's message and returns a stub assistant reply.
async function generateAssistantResponse({ message, searchResults }) {
  // A real implementation could use OpenAI's chat/completions API here.
  // For now we just return a friendly echo with the search results count.
  const hits = Array.isArray(searchResults?.hits) ? searchResults.hits.length : 0;
  return `You said: ${message}. I found ${hits} search result(s).`;
}

// HTTP server request handler.
async function handler(req, res) {
  // Enable CORS for all routes. Also handle preflight requests.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = parseUrl(req.url || '', true);
  const { pathname } = url;

  // Serve static files from the public directory. When the request path does
  // not start with '/api', attempt to locate a file under the 'public'
  // directory relative to the server root. If a file exists, serve it with
  // the appropriate content type. Otherwise fall through to API handling
  // which will return 404 if the path is not an API endpoint.
  if (req.method === 'GET' && pathname && !pathname.startsWith('/api')) {
    try {
      // Determine the file to serve. Default to index.html when requesting '/'.
      let filePath = pathname === '/' ? '/index.html' : pathname;
      // Protect against directory traversal attacks by resolving the file
      // relative to the public directory. Requests for files outside of
      // public will throw.
      const publicDir = resolvePath(process.cwd(), 'public');
      const resolved = resolvePath(publicDir, '.' + filePath);
      if (!resolved.startsWith(publicDir)) {
        throw new Error('Forbidden');
      }
      const data = await readFile(resolved);
      // Determine content type based on file extension.
      const ext = resolved.split('.').pop();
      let contentType = 'text/plain';
      if (ext === 'html') contentType = 'text/html';
      else if (ext === 'js') contentType = 'application/javascript';
      else if (ext === 'css') contentType = 'text/css';
      else if (ext === 'json') contentType = 'application/json';
      else if (ext === 'png') contentType = 'image/png';
      else if (ext === 'jpg' || ext === 'jpeg') contentType = 'image/jpeg';
      // Send file
      res.statusCode = 200;
      res.setHeader('Content-Type', contentType);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.end(data);
      return;
    } catch (err) {
      // If file not found, fall through to API handling
    }
  }

  // Health check endpoint
  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { status: 'ok' });
  }

  // SSE stream endpoint
  if (req.method === 'GET' && pathname && pathname.startsWith('/api/stream/')) {
    const runId = pathname.split('/').pop();
    const run = runs.get(runId);
    if (!run) {
      res.statusCode = 404;
      res.end();
      return;
    }
    // Set headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.(); // In Node < 18 flushHeaders may not be defined
    run.clients.add(res);
    // Replay existing events
    for (const ev of run.events) {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
    // Remove client when connection closes
    req.on('close', () => {
      run.clients.delete(res);
    });
    return;
  }

  // Chat endpoint
  if (req.method === 'POST' && pathname === '/api/chat') {
    // Collect request body
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        const { message, threadId } = data;
        if (typeof message !== 'string' || !message.trim()) {
          return sendJson(res, 400, { error: 'message is required' });
        }
        // Create run state
        const runId = randomUUID();
        const run = { id: runId, events: [], clients: new Set(), done: false };
        runs.set(runId, run);
        // Resolve or create thread
        let thread;
        if (threadId && threads.has(threadId)) {
          thread = threads.get(threadId);
        } else {
          thread = { id: randomUUID(), history: [] };
          threads.set(thread.id, thread);
        }
        // Kick off async processing outside of request cycle
        (async () => {
          try {
            // Fake search tool start
            const searchCardId = randomUUID();
            pushEvent(run, { type: 'tool_start', tool: 'search', input: { query: message }, cardId: searchCardId });
            // Fake search results
            const fakeResults = { hits: [{ title: 'Placeholder', snippet: 'This is a fake result.' }] };
            pushEvent(run, { type: 'tool_done', tool: 'search', output: fakeResults, cardId: searchCardId });
            // Generate assistant response
            const assistantOutput = await generateAssistantResponse({ message, searchResults: fakeResults });
            pushEvent(run, { type: 'assistant_done', text: assistantOutput, threadId: thread.id });
          } catch (err) {
            pushEvent(run, { type: 'assistant_done', text: `An error occurred: ${err?.message || err}`, threadId: thread.id });
          } finally {
            run.done = true;
            for (const client of run.clients) {
              client.end();
            }
          }
        })();
        // Respond immediately
        sendJson(res, 200, { runId, threadId: thread.id });
      } catch (err) {
        return sendJson(res, 400, { error: 'Invalid JSON' });
      }
    });
    return;
  }

  // Not found
  res.statusCode = 404;
  res.end();
}

const server = createServer(handler);
// Start server if not in test mode
if (process.env.NODE_ENV !== 'test') {
  const port = process.env.PORT || 8787;
  server.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
}

export default server;
