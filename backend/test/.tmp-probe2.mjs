// 一次性探针2（跑完即删）：真实中间件链逐层打点，定位 server-config 挂起
import express from 'express';
import { authenticate } from '../src/auth/middleware.js';
import { requirePlatformAdmin } from '../src/auth/authorize.js';
import { getMcpServer } from '../src/timesheet/configs.js';

const app = express();
app.use(express.json());
const tag = (name) => async (req, res, next) => { console.log(`[layer] enter ${name}`); next(); };
app.post('/login', (req, res) => res.json({ token: 'fake', user: { id: 1, username: 'admin', role: 'admin' } }));
app.get('/t1', tag('auth'), authenticate, tag('rpa'), requirePlatformAdmin(), tag('handler'), (req, res) => { console.log('[layer] handler body start'); const m = getMcpServer(); console.log('[layer] getMcpServer done', m.url); res.json({ ok: true, url: m.url }); });
app.use((err, req, res, next) => { console.log('[err-mw]', err && err.message); res.status(500).json({ error: String(err && err.message) }); });

const srv = app.listen(4597, async () => {
  console.log('[probe] listening 4597');
  await new Promise((r) => setTimeout(r, 300));
  try {
    const r = await fetch('http://localhost:4597/t1', { signal: AbortSignal.timeout(6000), headers: { Authorization: 'Bearer fake' } });
    console.log('[probe] /t1 ->', r.status, await r.text());
  } catch (e) { console.log('[probe] /t1 ERR', e.message); }
  process.exit(0);
});
