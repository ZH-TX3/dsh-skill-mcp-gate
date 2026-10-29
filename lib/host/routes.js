/**
 * Web API。契约：WebRoute.handler 是 `(req, res) => void` ——
 * handler 必须自己写响应体，返回值会被忽略（返回对象会让请求永远悬空）。
 */

export const API = '/api/skill-mcp-gate'

function sendJson(res, value, status = 200) {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

export function createRoutes(api) {
  const { token } = api
  const authed = (req) => req.headers['x-gate-token'] === token

  async function withBody(req, res, run) {
    if (req.method !== 'POST') return sendJson(res, { error: 'method not allowed' }, 405)
    if (!authed(req)) return sendJson(res, { error: 'invalid token' }, 403)
    try {
      const body = JSON.parse((await readBody(req)) || '{}')
      sendJson(res, await run(body))
    } catch (error) {
      sendJson(res, { error: error.message }, 400)
    }
  }

  return [
    { kind: 'exact', path: `${API}/token`, handler: (_req, res) => sendJson(res, { token }) },
    {
      kind: 'exact',
      path: `${API}/state`,
      handler: async (req, res) => {
        try {
          const ws = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('ws')
          if (ws) api.select(ws)
          sendJson(res, await api.snapshot())
        } catch (error) { sendJson(res, { error: error.message }, 500) }
      },
    },
    {
      kind: 'exact',
      path: `${API}/skill`,
      handler: (req, res) => withBody(req, res, async (body) => {
        const result = api.setSkill(body.name, body.state, body.ws)
        return { ok: true, ...result, state: await api.snapshot() }
      }),
    },
    {
      kind: 'exact',
      path: `${API}/mcp`,
      handler: (req, res) => withBody(req, res, async (body) => {
        api.setServer(body.server, body.state, body.ws)
        return { ok: true, state: await api.snapshot() }
      }),
    },
    {
      kind: 'exact',
      path: `${API}/tool`,
      handler: (req, res) => withBody(req, res, async (body) => {
        api.setTool(body.server, body.tool, body.state, body.ws)
        return { ok: true, state: await api.snapshot() }
      }),
    },
    {
      kind: 'exact',
      path: `${API}/mcp/add`,
      handler: (req, res) => withBody(req, res, async (body) => {
        const result = await api.addServers(body.text, body.ws)
        return { ok: true, ...result, state: await api.snapshot() }
      }),
    },
    {
      kind: 'exact',
      path: `${API}/mcp/remove`,
      handler: (req, res) => withBody(req, res, async (body) => {
        const result = await api.removeServer(body.server)
        return { ok: true, ...result, state: await api.snapshot() }
      }),
    },
    {
      kind: 'exact',
      path: `${API}/mcp/rename`,
      handler: (req, res) => withBody(req, res, async (body) => {
        const result = await api.renameServer(body.from, body.to)
        return { ok: true, ...result, state: await api.snapshot() }
      }),
    },
    {
      kind: 'exact',
      path: `${API}/mcp/probe`,
      handler: (req, res) => withBody(req, res, async (body) => {
        return { ok: true, probe: await api.probeServer(body.server) }
      }),
    },
    {
      kind: 'exact',
      path: `${API}/mcp/definition`,
      handler: (req, res) => withBody(req, res, async (body) => {
        return { ok: true, definition: api.getDefinition(body.server) }
      }),
    },
    {
      kind: 'exact',
      path: `${API}/mcp/define`,
      handler: (req, res) => withBody(req, res, async (body) => {
        const result = await api.saveDefinition(body.server, body.json)
        return { ok: true, ...result, state: await api.snapshot() }
      }),
    },
    {
      kind: 'exact',
      path: `${API}/mcp/undefine`,
      handler: (req, res) => withBody(req, res, async (body) => {
        const result = await api.deleteDefinition(body.server)
        return { ok: true, ...result, state: await api.snapshot() }
      }),
    },
    {
      kind: 'exact',
      path: `${API}/reload`,
      handler: (req, res) => withBody(req, res, async () => {
        api.reload()
        return { ok: true, state: await api.snapshot() }
      }),
    },
  ]
}
