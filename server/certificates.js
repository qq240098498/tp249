// 放行单：按放行记录出具，单据编号按规则生成（FXD-YYYY-NNNN，不可重复、撤销不复用）；
// 支持登记对外发出与对方回执；单据出具后要改必须先撤销（写依据）再出新的；
// 一张单只对应一条有效放行记录；同一批次只允许一张有效单据；单据数字与台账可逐字段对账。

const { AppError } = require('./errors');
const store = require('./store');
const coldlib = require('./coldlib');

const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const RECEIPT_STATUS = ['已签收', '拒收', '其他'];

// 每个批次“当前生效”的放行决定：时刻最新的一条（id 兜底），且决定为放行
function activeReleaseMap(data) {
  const latest = {};
  for (const r of data.releases) {
    const prev = latest[r.batchId];
    if (!prev || r.decidedAt > prev.decidedAt || (r.decidedAt === prev.decidedAt && r.id > prev.id)) {
      latest[r.batchId] = r;
    }
  }
  const map = {};
  for (const batchId of Object.keys(latest)) {
    if (latest[batchId].decision === '放行') map[batchId] = latest[batchId];
  }
  return map;
}

function activeReleaseOf(data, batchId) {
  return activeReleaseMap(data)[batchId] || null;
}

function isActiveRelease(data, releaseId) {
  const map = activeReleaseMap(data);
  return Object.keys(map).some((bid) => map[bid].id === releaseId);
}

// 同一批次当前有效的单据：未撤销，且对应的放行记录仍有效
function activeCertificateOfBatch(data, batchId) {
  return data.releaseCertificates.find((c) => c.status !== '已撤销' && c.batchId === batchId) || null;
}

// 单据编号规则：FXD-YYYY-NNNN，年份取出具日期，序号在当年递增；撤销、作废都不复用号
function generateCertNo(data, year) {
  const prefix = 'FXD-' + year + '-';
  let seq = 0;
  for (const c of data.releaseCertificates) {
    const m = String(c.certNo || '').match(new RegExp('^' + prefix + '(\\d+)$'));
    if (m) seq = Math.max(seq, Number(m[1]));
  }
  let candidate = '';
  do {
    seq += 1;
    candidate = prefix + String(seq).padStart(4, '0');
  } while (data.releaseCertificates.some((c) => c.certNo === candidate));
  return candidate;
}

// 判定四条的当时口径（与批次详情里的放行判定保持一致）
function conditionItems(check) {
  const items = (check.conditions || []).map((c) => ({
    key: c.key, text: c.text, ok: c.ok, value: c.value, limit: c.limit,
  }));
  const expired = check.expiredProbes || [];
  items.push({
    key: 'calibration',
    text: '参与判定的探头都在校准有效期内',
    ok: expired.length === 0,
    value: expired.length,
    limit: 0,
  });
  return items;
}

// 出具时把台账口径原样快照到单据上，对外单据不再手抄。
// MKT 与超限数字直接取放行记录里存的“当时”值；判定四条在出具时按当时数据定格。
function buildSnapshot(data, batch, release) {
  const check = coldlib.releaseCheck(data, batch);
  const room = data.rooms.find((r) => r.id === batch.roomId) || {};
  return {
    batchId: batch.id,
    batchCode: batch.code,
    product: batch.product,
    spec: batch.spec,
    units: Number(batch.units),
    roomId: batch.roomId,
    roomCode: room.code || '',
    roomName: room.name || '',
    supplier: batch.supplier || '',
    loadedAt: batch.loadedAt,
    releaseId: release.id,
    decision: release.decision,
    decidedAt: release.decidedAt,
    decider: release.decider,
    basis: release.basis || '',
    mkt: Number(release.mkt),
    longestExcursionMinutes: Number(release.longestExcursionMinutes),
    totalExcursionMinutes: Number(release.totalExcursionMinutes),
    chainGapCount: Number(release.chainGapCount),
    recordCount: check.recordCount,
    firstAt: check.firstAt,
    lastAt: check.lastAt,
    conditions: conditionItems(check),
    temperatureBand: {
      lowerLimitC: Number(data.settings.lowerLimitC),
      upperLimitC: Number(data.settings.upperLimitC),
    },
    limits: {
      allowExcursionMinutes: Number(data.settings.allowExcursionMinutes),
      allowTotalExcursionMinutes: Number(data.settings.allowTotalExcursionMinutes),
      chainGapMinutes: Number(data.settings.chainGapMinutes),
    },
  };
}

// 快照字段 -> 台账当前值。任何一处对不上都点名字段与两边的值
const SNAPSHOT_FIELDS = [
  { key: 'batchCode', label: '批次号', kind: 'text', cert: (s) => s.batchCode, ledger: (d, r, b) => (b ? b.code : '') },
  { key: 'product', label: '品名', kind: 'text', cert: (s) => s.product, ledger: (d, r, b) => (b ? b.product : '') },
  { key: 'spec', label: '规格', kind: 'text', cert: (s) => s.spec, ledger: (d, r, b) => (b ? b.spec : '') },
  { key: 'units', label: '件数', kind: 'num', cert: (s) => Number(s.units), ledger: (d, r, b) => (b ? Number(b.units) : 0) },
  { key: 'roomCode', label: '所在冷库', kind: 'text', cert: (s) => s.roomCode, ledger: (d, r, b) => {
    const room = b ? d.rooms.find((x) => x.id === b.roomId) : null;
    return room ? room.code : '';
  } },
  { key: 'loadedAt', label: '入库时刻', kind: 'text', cert: (s) => s.loadedAt, ledger: (d, r, b) => (b ? b.loadedAt : '') },
  { key: 'decidedAt', label: '放行时刻', kind: 'text', cert: (s) => s.decidedAt, ledger: (d, r) => r.decidedAt },
  { key: 'decider', label: '经办人', kind: 'text', cert: (s) => s.decider, ledger: (d, r) => r.decider },
  { key: 'basis', label: '放行依据', kind: 'text', cert: (s) => s.basis, ledger: (d, r) => r.basis || '' },
  { key: 'mkt', label: '当时的 MKT(℃)', kind: 'num', cert: (s) => Number(s.mkt), ledger: (d, r) => Number(r.mkt) },
  { key: 'longestExcursionMinutes', label: '最长超限(分)', kind: 'num', cert: (s) => Number(s.longestExcursionMinutes), ledger: (d, r) => Number(r.longestExcursionMinutes) },
  { key: 'totalExcursionMinutes', label: '累计超限(分)', kind: 'num', cert: (s) => Number(s.totalExcursionMinutes), ledger: (d, r) => Number(r.totalExcursionMinutes) },
  { key: 'chainGapCount', label: '断链数', kind: 'num', cert: (s) => Number(s.chainGapCount), ledger: (d, r) => Number(r.chainGapCount) },
];

function valuesEqual(kind, a, b) {
  if (kind === 'num') return Number(a) === Number(b);
  return String(a == null ? '' : a) === String(b == null ? '' : b);
}

// 对账：单据快照逐字段比台账同一条放行记录（及所属批次），并确认对应记录仍是有效放行记录
function reconcileCertificate(data, cert) {
  const release = data.releases.find((r) => r.id === cert.releaseId) || null;
  const batch = data.batches.find((b) => b.id === cert.batchId) || null;
  const diffs = [];
  if (!release) {
    return {
      consistent: false,
      releaseExists: false,
      releaseActive: false,
      batchExists: !!batch,
      diffs: [{ field: 'releaseId', label: '放行记录', certValue: cert.releaseId, ledgerValue: '', note: '台账里找不到这条放行记录' }],
    };
  }
  for (const f of SNAPSHOT_FIELDS) {
    const certValue = f.cert(cert.snapshot || {});
    const ledgerValue = f.ledger(data, release, batch);
    if (!valuesEqual(f.kind, certValue, ledgerValue)) {
      diffs.push({ field: f.key, label: f.label, certValue: certValue, ledgerValue: ledgerValue });
    }
  }
  const active = isActiveRelease(data, release.id);
  return {
    consistent: diffs.length === 0 && active,
    releaseExists: true,
    releaseActive: active,
    batchExists: !!batch,
    diffs: diffs,
  };
}

function decorateCertificate(data, cert, withDiffs) {
  const batch = data.batches.find((b) => b.id === cert.batchId) || null;
  const rec = reconcileCertificate(data, cert);
  const supersedes = data.releaseCertificates.find((c) => c.id === cert.supersedesCertId) || null;
  const replacedBy = data.releaseCertificates.find((c) => c.id === cert.replacedByCertId) || null;
  const out = Object.assign({}, cert, {
    batchCode: batch ? batch.code : '',
    product: batch ? batch.product : '',
    receiptStatus: cert.receipt ? cert.receipt.status : (cert.status === '已发出' ? '待回执' : ''),
    consistent: rec.consistent,
    diffCount: rec.diffs.length,
    releaseExists: rec.releaseExists,
    releaseActive: rec.releaseActive,
    supersedesCertNo: supersedes ? supersedes.certNo : '',
    replacedByCertNo: replacedBy ? replacedBy.certNo : '',
  });
  if (withDiffs) out.reconcile = rec;
  return out;
}

function findCert(data, idOrNo) {
  return data.releaseCertificates.find((c) => c.id === idOrNo || c.certNo === idOrNo) || null;
}

function listCertificates(data, query) {
  const q = query || {};
  let rows = data.releaseCertificates.slice();
  if (q.batchId) rows = rows.filter((c) => c.batchId === q.batchId);
  if (q.status) rows = rows.filter((c) => c.status === q.status);
  if (q.receiptStatus) {
    rows = rows.filter((c) => {
      if (q.receiptStatus === '待回执') return c.status === '已发出' && (!c.receipt || c.receipt.status === '待回执');
      return c.receipt && c.receipt.status === q.receiptStatus;
    });
  }
  if (q.keyword) {
    const kw = String(q.keyword).toLowerCase();
    rows = rows.filter((c) => {
      const batch = data.batches.find((b) => b.id === c.batchId);
      const hay = [c.certNo, c.send ? c.send.receiver : '', batch ? batch.code : '', batch ? batch.product : '']
        .join(' ').toLowerCase();
      return hay.includes(kw);
    });
  }
  const decorated = rows.map((c) => decorateCertificate(data, c, false));
  if (q.inconsistent === '1' || q.inconsistent === 'true') {
    return decorated.filter((c) => !c.consistent).sort((a, b) => (a.issuedAt < b.issuedAt ? 1 : -1));
  }
  return decorated.sort((a, b) => (a.issuedAt < b.issuedAt ? 1 : -1));
}

function certificateDetail(data, idOrNo) {
  const cert = findCert(data, idOrNo);
  if (!cert) throw new AppError(404, 'CERT_NOT_FOUND', '这张放行单不存在');
  return decorateCertificate(data, cert, true);
}

// 按放行记录出具放行单
function issueCertificate(data, payload) {
  const release = data.releases.find((r) => r.id === payload.releaseId);
  if (!release) throw new AppError(404, 'RELEASE_NOT_FOUND', '台账里没有这条放行记录', { releaseId: String(payload.releaseId || '') });
  if (release.decision !== '放行') {
    throw new AppError(409, 'RELEASE_NOT_RELEASABLE', '只有放行决定才能出具放行单，这条记录是「' + release.decision + '」', { releaseId: release.id });
  }
  if (!isActiveRelease(data, release.id)) {
    throw new AppError(409, 'RELEASE_NOT_ACTIVE', '这条放行记录已被之后的决定取代，不是当前有效记录，不能出具放行单', { releaseId: release.id });
  }
  const batch = data.batches.find((b) => b.id === release.batchId);
  if (!batch) throw new AppError(409, 'BATCH_NOT_FOUND', '这条放行记录对应的批次已经不在台账里', { batchId: release.batchId });

  const existing = activeCertificateOfBatch(data, batch.id);
  if (existing) {
    throw new AppError(409, 'CERT_ALREADY_ISSUED', '批次 ' + batch.code + ' 已出过放行单 ' + existing.certNo + '（' + existing.status + '）；要改请先撤销原单再出新的', {
      batchCode: batch.code, certNo: existing.certNo, certStatus: existing.status,
    });
  }

  const errors = {};
  const issuedAt = payload.issuedAt ? String(payload.issuedAt) : store.nowText();
  if (!TIME_RE.test(issuedAt)) errors.issuedAt = '出具时刻格式要像 2026-09-06 10:30:00';
  if (!String(payload.issuer || '').trim()) errors.issuer = '出具经办人要填';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '出具放行单有几项没通过校验', errors);

  const year = issuedAt.slice(0, 4);
  const cert = {
    id: store.nextId('ct', data.releaseCertificates),
    certNo: generateCertNo(data, year),
    releaseId: release.id,
    batchId: batch.id,
    issuedAt: issuedAt,
    issuer: String(payload.issuer).trim(),
    snapshot: buildSnapshot(data, batch, release),
    status: '已出具',
    send: null,
    receipt: null,
    supersedesCertId: '',
    replacedByCertId: '',
    revokedAt: '',
    revokedBy: '',
    revokeReason: '',
  };

  // 同批次若以前出过又撤销过，新单接续旧单链路
  const lastRevoked = data.releaseCertificates
    .filter((c) => c.batchId === batch.id && c.status === '已撤销')
    .sort((a, b) => (a.revokedAt < b.revokedAt ? 1 : -1))[0];
  if (lastRevoked) {
    cert.supersedesCertId = lastRevoked.id;
    lastRevoked.replacedByCertId = cert.id;
  }

  data.releaseCertificates.push(cert);
  return decorateCertificate(data, cert, true);
}

function requireWritable(cert) {
  if (cert.status === '已撤销') {
    throw new AppError(409, 'CERT_REVOKED', '放行单 ' + cert.certNo + ' 已经撤销，不能再登记发出或回执', { certNo: cert.certNo });
  }
}

// 登记对外发出
function sendCertificate(data, idOrNo, payload) {
  const cert = findCert(data, idOrNo);
  if (!cert) throw new AppError(404, 'CERT_NOT_FOUND', '这张放行单不存在');
  requireWritable(cert);
  if (cert.status === '已发出') {
    throw new AppError(409, 'CERT_ALREADY_SENT', '放行单 ' + cert.certNo + ' 已在 ' + cert.send.sentAt + ' 发出；要更改必须先撤销再出新单', {
      certNo: cert.certNo, sentAt: cert.send.sentAt, receiver: cert.send.receiver,
    });
  }
  const errors = {};
  if (!String(payload.receiver || '').trim()) errors.receiver = '接收方要填';
  const sentAt = payload.sentAt ? String(payload.sentAt) : store.nowText();
  if (!TIME_RE.test(sentAt)) errors.sentAt = '发出时刻格式要像 2026-09-06 14:00:00';
  if (payload.sentAt && !String(payload.sentBy || '').trim() && !String(payload.sender || '').trim()) errors.sentBy = '登记发出的经办人要填';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '登记发出有几项没通过校验', errors);

  cert.status = '已发出';
  cert.send = {
    sentAt: sentAt,
    receiver: String(payload.receiver).trim(),
    sentBy: String(payload.sentBy || payload.sender || '').trim(),
    channel: String(payload.channel || '').trim(),
  };
  cert.receipt = { status: '待回执', receiptAt: '', note: '', receivedBy: '' };
  return decorateCertificate(data, cert, true);
}

// 登记对方回执
function receiptCertificate(data, idOrNo, payload) {
  const cert = findCert(data, idOrNo);
  if (!cert) throw new AppError(404, 'CERT_NOT_FOUND', '这张放行单不存在');
  requireWritable(cert);
  if (cert.status !== '已发出') {
    throw new AppError(409, 'CERT_NOT_SENT', '放行单 ' + cert.certNo + ' 还没对外发出，不能登记回执', { certNo: cert.certNo });
  }
  const errors = {};
  if (!RECEIPT_STATUS.includes(payload.status)) errors.status = '回执状态只能是：' + RECEIPT_STATUS.join('、');
  const receiptAt = payload.receiptAt ? String(payload.receiptAt) : store.nowText();
  if (!TIME_RE.test(receiptAt)) errors.receiptAt = '回执时刻格式要像 2026-09-06 15:00:00';
  if (cert.send && receiptAt < cert.send.sentAt) errors.receiptAt = '回执时刻不能早于发出时刻（' + cert.send.sentAt + '）';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '登记回执有几项没通过校验', errors);

  cert.receipt = {
    status: payload.status,
    receiptAt: receiptAt,
    receivedBy: String(payload.receivedBy || '').trim(),
    note: String(payload.note || '').trim(),
  };
  return decorateCertificate(data, cert, true);
}

// 撤销：必须写依据；撤销后同批次才能出新单，旧单号保留不复用
function revokeCertificate(data, idOrNo, payload) {
  const cert = findCert(data, idOrNo);
  if (!cert) throw new AppError(404, 'CERT_NOT_FOUND', '这张放行单不存在');
  if (cert.status === '已撤销') throw new AppError(409, 'CERT_REVOKED', '放行单 ' + cert.certNo + ' 已经撤销过了', { certNo: cert.certNo });
  const errors = {};
  if (!String(payload.reason || '').trim()) errors.reason = '撤销依据要填';
  if (!String(payload.revokedBy || '').trim()) errors.revokedBy = '撤销经办人要填';
  const revokedAt = payload.revokedAt ? String(payload.revokedAt) : store.nowText();
  if (!TIME_RE.test(revokedAt)) errors.revokedAt = '撤销时刻格式要像 2026-09-06 16:00:00';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '撤销放行单有几项没通过校验', errors);

  cert.status = '已撤销';
  cert.revokedAt = revokedAt;
  cert.revokedBy = String(payload.revokedBy).trim();
  cert.revokeReason = String(payload.reason).trim();
  return decorateCertificate(data, cert, true);
}

function reconcileAll(data, query) {
  const q = query || {};
  let rows = listCertificates(data, {});
  if (q.batchId) rows = rows.filter((c) => c.batchId === q.batchId);
  rows = rows.map((c) => decorateCertificate(data, c, true));
  if (q.consistent === 'false' || q.inconsistent === '1') rows = rows.filter((c) => !c.consistent);
  return {
    total: rows.length,
    consistentCount: rows.filter((c) => c.consistent).length,
    inconsistentCount: rows.filter((c) => !c.consistent).length,
    certificates: rows,
  };
}

// 给放行台账用：一条放行记录关联的单据情况
function certificatesOfRelease(data, releaseId) {
  const all = data.releaseCertificates
    .filter((c) => c.releaseId === releaseId)
    .map((c) => decorateCertificate(data, c, false))
    .sort((a, b) => (a.issuedAt < b.issuedAt ? 1 : -1));
  const active = all.find((c) => c.status !== '已撤销') || null;
  return {
    all: all,
    active: active,
    certCount: all.length,
    activeCertNo: active ? active.certNo : '',
    certStatus: active ? active.status : (all.length ? '已撤销' : ''),
    receiptStatus: active ? (active.receiptStatus || '') : (all.length ? '已撤销' : ''),
    consistent: active ? active.consistent : null,
    diffCount: active ? active.diffCount : 0,
  };
}

module.exports = {
  RECEIPT_STATUS,
  activeReleaseMap,
  activeReleaseOf,
  isActiveRelease,
  activeCertificateOfBatch,
  generateCertNo,
  reconcileCertificate,
  decorateCertificate,
  listCertificates,
  certificateDetail,
  issueCertificate,
  sendCertificate,
  receiptCertificate,
  revokeCertificate,
  reconcileAll,
  certificatesOfRelease,
};
