/**
 * 快手新品分品数据看板 · CloudBase 云托管版
 * 数据存储于 CloudBase 文档型数据库，多用户实时共享
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 8080;
const ENV = 'kuaishou-db-d0gk9inmf1d5d9927';
const PUBLIC_DIR = path.join(__dirname, 'public');
// 使用固定设备ID，确保容器重启/部署后仍访问同一数据分区
const CB_DEVICE_ID = process.env.CB_DEVICE_ID || 'svr_dash_fixed_2026';

// ===== CloudBase API 封装 =====
let tokenCache = { token: '', expiresAt: 0 };

function cbFetch(path, method, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: `${ENV}.api.tcloudbasegateway.com`,
      path,
      method,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'x-device-id': CB_DEVICE_ID },
    };
    if (tokenCache.token) opts.headers['Authorization'] = 'Bearer ' + tokenCache.token;
    const r = https.request(opts, (resp) => {
      let d = '';
      resp.on('data', (c) => { d += c; });
      resp.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch (e) { reject(new Error('CloudBase 响应解析失败: ' + d.slice(0, 200))); }
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function cbLogin() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const r = await cbFetch('/auth/v1/signin/anonymously', 'POST');
  if (!r.access_token) throw new Error('CloudBase 登录失败: ' + JSON.stringify(r));
  tokenCache = { token: r.access_token, expiresAt: Date.now() + (r.expires_in || 3600) * 1000 * 0.8 };
  console.log('[CB] Token 已刷新');
  return tokenCache.token;
}

async function cbAPI(method, path, body) {
  await cbLogin();
  const r = await cbFetch(path, method, body);
  if (r.code) throw new Error(r.message || r.code);
  return r;
}

const cb = {
  // 查询全部文档（修复：order 参数需 URL 编码，避免特殊字符导致请求失败）
  async listAll(collection) {
    const all = [];
    let offset = 0;
    const pageSize = 200;
    while (true) {
      const q = `offset=${offset}&limit=${pageSize}`;
      const r = await cbAPI('GET', `/v1/database/instances/(default)/databases/(default)/collections/${collection}/documents?${q}`);
      if (!r.list || r.list.length === 0) break;
      all.push(...r.list);
      if (r.list.length < pageSize) break;
      offset += pageSize;
    }
    return all;
  },

  // 条件查询
  async query(collection, queryObj) {
    const q = `query=${encodeURIComponent(JSON.stringify(queryObj))}&limit=100`;
    const r = await cbAPI('GET', `/v1/database/instances/(default)/databases/(default)/collections/${collection}/documents?${q}`);
    return r.list || [];
  },

  // 新增
  async insert(collection, doc) {
    return cbAPI('POST', `/v1/database/instances/(default)/databases/(default)/collections/${collection}/documents`, { data: [doc] });
  },

  // 更新
  async update(collection, docId, doc) {
    return cbAPI('PATCH', `/v1/database/instances/(default)/databases/(default)/collections/${collection}/documents/${docId}`, { data: doc });
  },

  // 删除
  async remove(collection, docId) {
    return cbAPI('DELETE', `/v1/database/instances/(default)/databases/(default)/collections/${collection}/documents/${docId}`);
  },

  // 获取飞书配置
  async getFeishuConfig() {
    try {
      const docs = await cb.listAll('config');
      for (const d of docs) {
        if (d.key === 'feishu') return d.value;
      }
      return null;
    } catch (e) { return null; }
  },

  async setFeishuConfig(data) {
    try {
      const docs = await cb.listAll('config');
      const existing = docs.find(d => d.key === 'feishu');
      if (existing) {
        await cb.update('config', existing._id, { key: 'feishu', value: data, updatedAt: Date.now() });
      } else {
        await cb.insert('config', { key: 'feishu', value: data, updatedAt: Date.now() });
      }
    } catch (e) { throw e; }
  },
};

// ===== 工具函数 =====
function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function normalizeRecords(docs) {
  return docs.map(d => {
    const { _id, _openid, ...r } = d;
    // 处理 CloudBase 的各种数字类型
    if (r.hour && r.hour.$numberInt) r.hour = parseInt(r.hour.$numberInt);
    if (r.hour && r.hour.$numberDouble) r.hour = parseInt(r.hour.$numberDouble);
    if (r.spend && r.spend.$numberInt) r.spend = parseInt(r.spend.$numberInt);
    if (r.spend && r.spend.$numberDouble) r.spend = parseInt(r.spend.$numberDouble);
    if (r.gmv && r.gmv.$numberInt) r.gmv = parseInt(r.gmv.$numberInt);
    if (r.gmv && r.gmv.$numberDouble) r.gmv = parseInt(r.gmv.$numberDouble);
    return r;
  });
}

// 从 CloudBase 文档中安全提取数字时间戳
function safeTs(val) {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  if (val.$numberInt) return parseInt(val.$numberInt);
  if (val.$numberLong) return parseInt(val.$numberLong);
  if (val.$numberDouble) return parseInt(val.$numberDouble);
  return parseInt(val) || 0;
}

function json(res, data, status) {
  res.writeHead(status || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ===== 飞书 API 集成 =====
let feishuTokenCache = { token: null, expire: 0 };

function feishuRequest(pathStr, method, data) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: 'open.feishu.cn', path: pathStr, method: method || 'GET', headers: { 'Content-Type': 'application/json; charset=utf-8' } };
    const r = https.request(opts, (resp) => {
      let body = '';
      resp.on('data', (c) => { body += c; });
      resp.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('飞书响应解析失败')); } });
    });
    r.on('error', reject);
    if (data) r.write(JSON.stringify(data));
    r.end();
  });
}

async function getFeishuToken() {
  const cfg = await cb.getFeishuConfig();
  if (!cfg || !cfg.appId || !cfg.appSecret) throw new Error('飞书未配置');
  if (feishuTokenCache.token && Date.now() < feishuTokenCache.expire - 300000) return feishuTokenCache.token;
  const j = await feishuRequest('/open-apis/auth/v3/tenant_access_token/internal', 'POST', { app_id: cfg.appId, app_secret: cfg.appSecret });
  if (j.tenant_access_token) {
    feishuTokenCache = { token: j.tenant_access_token, expire: Date.now() + (j.expire || 7200) * 1000 };
    return j.tenant_access_token;
  }
  throw new Error(j.msg || '获取飞书 token 失败');
}

function feishuApi(pathStr, method, data) {
  return new Promise((resolve, reject) => {
    getFeishuToken().then(token => {
      const r = https.request({
        hostname: 'open.feishu.cn', path: pathStr, method: method || 'GET',
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': 'Bearer ' + token },
      }, (resp) => {
        let body = '';
        resp.on('data', (c) => { body += c; });
        resp.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('飞书响应解析失败')); } });
      });
      r.on('error', reject);
      if (data) r.write(JSON.stringify(data));
      r.end();
    }).catch(reject);
  });
}

async function feishuListRecords() {
  const cfg = await cb.getFeishuConfig();
  if (!cfg || !cfg.appToken || !cfg.tableId) throw new Error('飞书未配置');
  const basePath = `/open-apis/bitable/v1/apps/${cfg.appToken}/tables/${cfg.tableId}/records`;
  const all = [];
  let pageToken = null;
  do {
    let q = '?page_size=100';
    if (pageToken) q += '&page_token=' + encodeURIComponent(pageToken);
    const resp = await feishuApi(basePath + q);
    if (resp.code !== 0) throw new Error(resp.msg || '飞书读取失败');
    all.push(...(resp.data && resp.data.items || []));
    pageToken = (resp.data && resp.data.page_token) || null;
    if (!resp.data || !resp.data.has_more) break;
  } while (pageToken);
  return all.map(item => ({
    _id: item.record_id,
    date: (item.fields['日期'] || '').toString(),
    hour: parseInt(item.fields['分时'] || 0, 10),
    product: (item.fields['产品'] || '').toString(),
    owner: (item.fields['负责人'] || '').toString(),
    spend: parseFloat(item.fields['消耗'] || 0) || 0,
    gmv: parseFloat(item.fields['GMV'] || 0) || 0,
  }));
}

async function feishuUpsertRecord(rec) {
  const cfg = await cb.getFeishuConfig();
  const basePath = `/open-apis/bitable/v1/apps/${cfg.appToken}/tables/${cfg.tableId}/records`;
  const fields = { '日期': rec.date, '分时': rec.hour, '产品': rec.product, '负责人': rec.owner, '消耗': rec.spend, 'GMV': rec.gmv };
  const all = await feishuListRecords();
  const existing = all.find(r => r.date === rec.date && r.hour === rec.hour && r.product === rec.product);
  if (existing && existing._id) {
    await feishuApi(basePath + '/' + existing._id, 'PUT', { fields });
  } else {
    await feishuApi(basePath, 'POST', { fields });
  }
  return await feishuListRecords();
}

async function feishuDeleteRecord(recordId) {
  const cfg = await cb.getFeishuConfig();
  await feishuApi(`/open-apis/bitable/v1/apps/${cfg.appToken}/tables/${cfg.tableId}/records/${recordId}`, 'DELETE');
  return await feishuListRecords();
}

// ===== 静态文件服务 =====
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
};

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  pathname = pathname.replace(/\.\./g, '');
  const filePath = path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (path.extname(pathname) === '') {
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
          if (e2) { res.writeHead(404); res.end('Not Found'); return; }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d2);
        });
      } else { res.writeHead(404); res.end('Not Found'); }
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ===== 自动备份函数（写入后触发，5分钟内不重复）=====
let backupTimer = null;
let lastBackupAt = 0;
let lastBackupSig = '';
async function autoBackup(source) {
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = setTimeout(async () => {
    try {
      // 节流：5分钟内只备份一次
      const now = Date.now();
      if (now - lastBackupAt < 5 * 60 * 1000) {
        console.log('[备份] 5分钟内已备份，跳过（' + source + '）');
        return;
      }
      await cbLogin();
      const docs = await cb.listAll('dashboard_records');
      if (docs.length === 0) { console.log('[备份] 无数据，跳过（' + source + '）'); return; }

      // 内容签名：仅当记录数或最后一条 _id 变化时才备份
      const sig = docs.length + '_' + (docs[docs.length-1]._id || '');
      if (sig === lastBackupSig) {
        console.log('[备份] 数据未变化，跳过（' + source + '）');
        return;
      }

      const opLogDocs = await cb.listAll('dashboard_oplog');
      const backupData = {
        records: docs,
        opLog: opLogDocs,
        backupTime: nowStamp(),
        backupTs: Date.now(),
        recordCount: docs.length
      };
      const backupKey = 'backup_' + Date.now();
      await cb.insert('config', { key: backupKey, value: backupData, updatedAt: Date.now() });
      lastBackupAt = Date.now();
      lastBackupSig = sig;
      console.log('[备份] ' + source + '自动备份 ' + docs.length + ' 条记录');
    } catch (e) {
      console.log('[备份] 自动备份失败（可忽略）:', e.message);
    }
  }, 5000);
}

// ===== HTTP 服务器 =====
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query = parsed.query;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(); return;
  }

  try {
    // ===== 备份 / 恢复 API =====

    // 手动备份当前数据（备份存储在 config 集合中，无需额外创建集合）
    if (pathname === '/api/backup' && req.method === 'POST') {
      const docs = await cb.listAll('dashboard_records');
      const opLogDocs = await cb.listAll('dashboard_oplog');
      const backupData = {
        records: docs,
        opLog: opLogDocs,
        backupTime: nowStamp(),
        backupTs: Date.now(),
        recordCount: docs.length
      };
      const backupKey = 'backup_' + Date.now();
      await cb.insert('config', { key: backupKey, value: backupData, updatedAt: Date.now() });
      console.log('[备份] 已备份 ' + docs.length + ' 条记录');
      return json(res, { ok: true, recordCount: docs.length, message: '已备份 ' + docs.length + ' 条记录' });
    }

    // 查看备份列表
    if (pathname === '/api/backup' && req.method === 'GET') {
      const configDocs = await cb.listAll('config');
      const backupDocs = configDocs.filter(d => d.key && d.key.startsWith('backup_'));
      // 按时间倒序
      backupDocs.sort((a, b) => {
        const ta = safeTs((a.value || {}).backupTs);
        const tb = safeTs((b.value || {}).backupTs);
        return tb - ta;
      });
      const list = backupDocs.slice(0, 10).map(d => {
        const v = d.value || {};
        return {
          _id: d._id,
          backupTime: v.backupTime || '未知',
          recordCount: safeTs(v.recordCount),
          backupTs: safeTs(v.backupTs)
        };
      });
      return json(res, { ok: true, backups: list });
    }

    // 从备份恢复数据
    if (pathname === '/api/restore' && req.method === 'POST') {
      const configDocs = await cb.listAll('config');
      const backupDocs = configDocs.filter(d => d.key && d.key.startsWith('backup_'));
      backupDocs.sort((a, b) => {
        const ta = safeTs((a.value || {}).backupTs);
        const tb = safeTs((b.value || {}).backupTs);
        return tb - ta;
      });
      
      if (backupDocs.length === 0) return json(res, { ok: false, error: '没有可用的备份' });
      const latest = backupDocs[0];
      const backupData = latest.value || {};
      
      // 先清空当前数据
      const current = await cb.listAll('dashboard_records');
      for (const doc of current) { await cb.remove('dashboard_records', doc._id); }
      const currentLogs = await cb.listAll('dashboard_oplog');
      for (const doc of currentLogs) { await cb.remove('dashboard_oplog', doc._id); }
      
      // 恢复记录
      const records = backupData.records || [];
      for (const rec of records) {
        const { _id, _openid, ...clean } = rec;
        try {
          await cb.insert('dashboard_records', clean);
        } catch (e) {
          console.error('[恢复] 插入记录失败:', e.message);
        }
      }
      
      // 恢复操作日志
      const opLogs = backupData.opLog || [];
      for (const log of opLogs) {
        const { _id, _openid, ...clean } = log;
        try {
          await cb.insert('dashboard_oplog', clean);
        } catch (e) {
          console.error('[恢复] 插入日志失败:', e.message);
        }
      }
      
      // 添加恢复日志
      await cb.insert('dashboard_oplog', { time: nowStamp(), operator: '系统自动恢复', action: '从备份恢复数据', count: records.length });
      
      return json(res, { ok: true, restored: records.length, message: '已从 ' + (backupData.backupTime || '未知') + ' 的备份恢复 ' + records.length + ' 条记录' });
    }

    // ===== 数据 API =====

    // 加载全部数据
    if (pathname === '/api/load' && req.method === 'GET') {
      const docs = await cb.listAll('dashboard_records');
      const records = normalizeRecords(docs);
      let opLog = [];
      try {
        const logDocs = await cb.listAll('dashboard_oplog');
        opLog = logDocs.map(d => { const { _id, _openid, ...l } = d; return l; });
      } catch (e) { /* 日志可能为空 */ }
      return json(res, { ok: true, records, opLog, build: '2026-08-12-recovery-v7' });
    }

    // 新增/更新记录
    if (pathname === '/api/records' && req.method === 'POST') {
      const rec = await readBody(req);
      const existing = await cb.query('dashboard_records', { date: rec.date, hour: rec.hour, product: rec.product });
      if (existing.length > 0) {
        await cb.update('dashboard_records', existing[0]._id, rec);
      } else {
        await cb.insert('dashboard_records', rec);
      }
      const docs = await cb.listAll('dashboard_records');
      const records = normalizeRecords(docs);
      autoBackup('写入');
      return json(res, { ok: true, records });
    if (pathname === '/api/records' && req.method === 'DELETE') {
      const { date, hour, product } = query;
      const existing = await cb.query('dashboard_records', { date, hour: parseInt(hour), product });
      for (const doc of existing) {
        await cb.remove('dashboard_records', doc._id);
      }
      const docs = await cb.listAll('dashboard_records');
      const records = normalizeRecords(docs);
      autoBackup('删除');
      return json(res, { ok: true, records });
    if (pathname === '/api/clear' && req.method === 'POST') {
      const all = await cb.listAll('dashboard_records');
      const opLogDocs = await cb.listAll('dashboard_oplog');
      
      // 自动备份：清除前先保存一份完整备份
      const backupData = {
        records: all,
        opLog: opLogDocs,
        backupTime: nowStamp(),
        backupTs: Date.now(),
        recordCount: all.length
      };
      const backupKey = 'backup_' + Date.now();
      await cb.insert('config', { key: backupKey, value: backupData, updatedAt: Date.now() });
      console.log('[备份] 清除前自动备份 ' + all.length + ' 条记录');
      
      // 记录清除操作日志
      await cb.insert('dashboard_oplog', { time: nowStamp(), operator: '未填写', action: '清除全部数据（已自动备份）', count: all.length });
      for (const doc of all) {
        await cb.remove('dashboard_records', doc._id);
      }
      return json(res, { ok: true, backupCount: all.length });
    }

    // ===== 飞书配置 API =====
    if (pathname === '/api/feishu/config' && req.method === 'GET') {
      const cfg = await cb.getFeishuConfig();
      return json(res, { ok: true, hasConfig: !!(cfg && cfg.appId && cfg.appSecret && cfg.appToken && cfg.tableId), appToken: cfg ? cfg.appToken : null, tableId: cfg ? cfg.tableId : null });
    }

    if (pathname === '/api/feishu/config' && req.method === 'POST') {
      const body = await readBody(req);
      await cb.setFeishuConfig({ appId: body.appId || '', appSecret: body.appSecret || '', appToken: body.appToken || '', tableId: body.tableId || '' });
      feishuTokenCache = { token: null, expire: 0 };
      return json(res, { ok: true });
    }

    // ===== 飞书数据 API =====
    if (pathname === '/api/feishu/records' && req.method === 'GET') {
      const records = await feishuListRecords();
      return json(res, { ok: true, records });
    }

    if (pathname === '/api/feishu/records' && req.method === 'POST') {
      const rec = await readBody(req);
      const records = await feishuUpsertRecord(rec);
      return json(res, { ok: true, records });
    }

    if (pathname === '/api/feishu/records' && req.method === 'DELETE') {
      if (!query.recordId) return json(res, { ok: false, error: '缺少 recordId' });
      const records = await feishuDeleteRecord(query.recordId);
      return json(res, { ok: true, records });
    }

    // ===== 静态文件 =====
    serveStatic(req, res, pathname);

  } catch (e) {
    console.error('[API] 错误:', e.message);
    json(res, { ok: false, error: e.message }, 500);
  }
});

server.listen(PORT, '0.0.0.0', async () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  console.log('');
  console.log('========================================');
  console.log('  快手新品分品数据看板 CloudBase 云托管版');
  console.log('  端口: ' + PORT);
  ips.forEach(ip => console.log('  局域网: http://' + ip + ':' + PORT));
  console.log('========================================');
  console.log('');
  
  // ===== 启动时备份一次 =====
  try {
    await cbLogin();
    const docs = await cb.listAll('dashboard_records');
    if (docs.length > 0) {
      const configDocs = await cb.listAll('config');
      const backupDocs = configDocs.filter(d => d.key && d.key.startsWith('backup_'));
      const now = Date.now();
      const hasRecent = backupDocs.some(d => {
        const v = d.value || {};
        const ts = safeTs(v.backupTs);
        return (now - ts) < 30 * 60 * 1000;
      });
      if (!hasRecent) {
        const opLogDocs = await cb.listAll('dashboard_oplog');
        const backupData = {
          records: docs,
          opLog: opLogDocs,
          backupTime: nowStamp(),
          backupTs: Date.now(),
          recordCount: docs.length
        };
        const backupKey = 'backup_' + Date.now();
        await cb.insert('config', { key: backupKey, value: backupData, updatedAt: Date.now() });

        // 清理旧备份：保留最近 20 条
        const allBackups = configDocs.filter(d => d.key && d.key.startsWith('backup_'));
        allBackups.sort((a, b) => {
          return safeTs((b.value || {}).backupTs) - safeTs((a.value || {}).backupTs);
        });
        const toDelete = allBackups.slice(20);
        for (const old of toDelete) {
          try { await cb.remove('config', old._id); } catch (e2) {}
        }

        console.log('[备份] 启动时自动备份 ' + docs.length + ' 条记录' + (toDelete.length ? '，清理旧备份 ' + toDelete.length + ' 条' : ''));
      }
    }
  } catch (e) {
    console.log('[备份] 启动备份失败（可忽略）:', e.message);
  }

  console.log('[备份] 写入即备份已启用（每次录入数据后自动备份）');
});
