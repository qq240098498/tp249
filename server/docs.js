// 放行单：按放行记录出具、对外发出与对方回执登记、撤销重出、与台账逐字段对账
const { AppError } = require('./errors');
const store = require('./store');

const DOC_STATUS = ['已出具', '已发出', '已撤销'];
const RECEIPT_STATUS = ['未发出', '待回执', '已回执', '对方拒收'];
const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

// 单据编号：FXD-出具年份-四位流水，全库不重号（撤销单也占号，绝不复用）
function nextDocNo(data, atText) {
  const year = String(atText || store.nowText()).slice(0, 4);
  const prefix = 'FXD-' + year + '-';
  let max = 0;
  for (const d of data.releaseDocs) {
    const no = String(d.docNo || '');
    if (no.startsWith(prefix)) {
      const n = Number(no.slice(prefix.length));
      if (Number.isFinite(n)) max = Math.max(max, n);
    }
  }
  let candidate = '';
  do {
    max += 1;
    candidate = prefix + String(max).padStart(4, '0');
  } while (data.releaseDocs.some((d) => d.docNo === candidate));
  return candidate;
}

function findDoc(data, id) {
  const doc = data.releaseDocs.find((d) => d.id === id);
  if (!doc) throw new AppError(404, 'DOC_NOT_FOUND', '这张放行单不存在');
  return doc;
}

// 对账要比的字段：单据快照 vs 台账里同一条放行记录（批次号取批次主数据）
const RECONCILE_FIELDS = [
  { key: 'batchCode', label: '批次号', num: false },
  { key: 'decidedAt', label: '决定时刻', num: false },
  { key: 'decider', label: '经办人', num: false },
  { key: 'mkt', label: '当时的 MKT', num: true },
  { key: 'longestExcursionMinutes', label: '最长超限（分）', num: true },
  { key: 'totalExcursionMinutes', label: '累计超限（分）', num: true },
  { key: 'chainGapCount', label: '断链数', num: true },
  { key: 'basis', label: '判定依据', num: false },
];

// 对账：逐字段比对，不一致的点名是哪一项、单据上与台账里各是什么；
// 结构上再查：台账记录还在不在、同一批次/同一条记录是不是只有这一张有效单
function reconcileDoc(data, doc) {
  if (doc.status === '已撤销') return { skipped: true, ok: true, diffs: [], problems: [] };
  const diffs = [];
  const problems = [];
  const release = data.releases.find((r) => r.id === doc.releaseId);
  if (!release) {
    problems.push('台账里找不到对应的放行记录（' + doc.releaseId + '），单据成了无源单');
  } else {
    const batch = data.batches.find((b) => b.id === release.batchId);
    const ledger = {
      batchCode: batch ? batch.code : '',
      decidedAt: release.decidedAt,
      decider: release.decider,
      mkt: release.mkt,
      longestExcursionMinutes: release.longestExcursionMinutes,
      totalExcursionMinutes: release.totalExcursionMinutes,
      chainGapCount: release.chainGapCount,
      basis: release.basis,
    };
    for (const f of RECONCILE_FIELDS) {
      const dv = doc[f.key];
      const lv = ledger[f.key];
      const same = f.num
        ? Number(dv) === Number(lv)
        : String(dv == null ? '' : dv) === String(lv == null ? '' : lv);
      if (!same) diffs.push({ field: f.key, label: f.label, docValue: dv, ledgerValue: lv });
    }
    if (release.batchId !== doc.batchId) {
      problems.push('单据挂在批次 ' + doc.batchId + ' 上，台账记录挂在 ' + release.batchId + ' 上');
    }
  }
  const batchTwins = data.releaseDocs.filter((d) => d.id !== doc.id && d.status !== '已撤销' && d.batchId === doc.batchId);
  if (batchTwins.length) {
    problems.push('这个批次还有另一张有效单：' + batchTwins.map((d) => d.docNo).join('、'));
  }
  const releaseTwins = data.releaseDocs.filter((d) => d.id !== doc.id && d.status !== '已撤销' && d.releaseId === doc.releaseId);
  if (releaseTwins.length) {
    problems.push('这条放行记录名下还有另一张有效单：' + releaseTwins.map((d) => d.docNo).join('、'));
  }
  return { ok: diffs.length === 0 && problems.length === 0, diffs, problems };
}

function decorateDoc(data, doc) {
  return Object.assign({}, doc, { reconcile: reconcileDoc(data, doc) });
}

function listDocs(data, query) {
  const q = query || {};
  let rows = data.releaseDocs.slice();
  if (q.status) rows = rows.filter((d) => d.status === q.status);
  if (q.receiptStatus) rows = rows.filter((d) => d.receiptStatus === q.receiptStatus);
  if (q.batchId) rows = rows.filter((d) => d.batchId === q.batchId);
  if (q.keyword) {
    const kw = String(q.keyword).toLowerCase();
    rows = rows.filter((d) => [d.docNo, d.batchCode, d.product, d.sentTo].some((f) => String(f || '').toLowerCase().includes(kw)));
  }
  let decorated = rows.map((d) => decorateDoc(data, d));
  if (q.reconcile === 'mismatch') decorated = decorated.filter((d) => d.status !== '已撤销' && !d.reconcile.ok);
  else if (q.reconcile === 'ok') decorated = decorated.filter((d) => d.status !== '已撤销' && d.reconcile.ok);
  return decorated.sort((a, b) => (a.issuedAt < b.issuedAt ? 1 : a.issuedAt > b.issuedAt ? -1 : (a.docNo < b.docNo ? 1 : -1)));
}

function docDetail(data, id) {
  return decorateDoc(data, findDoc(data, id));
}

// 出具：把台账记录与批次信息快照进单据；同一批次、同一条记录同时只能有一张有效单
function issueDoc(data, releaseId, payload) {
  const release = data.releases.find((r) => r.id === releaseId);
  if (!release) throw new AppError(404, 'RELEASE_NOT_FOUND', '这条放行记录不存在');
  if (release.decision !== '放行') {
    throw new AppError(409, 'DOC_ONLY_FOR_RELEASE', '只有决定为「放行」的台账记录才能出具放行单', { releaseId: release.id });
  }
  const batch = data.batches.find((b) => b.id === release.batchId);
  if (!batch) throw new AppError(404, 'BATCH_NOT_FOUND', '这条放行记录对应的批次不存在');
  const dupBatch = data.releaseDocs.find((d) => d.batchId === batch.id && d.status !== '已撤销');
  if (dupBatch) {
    throw new AppError(409, 'DOC_ALREADY_ISSUED',
      '这个批次已经出具过放行单 ' + dupBatch.docNo + '（' + dupBatch.status + '），不能重复出具；要改请先撤销原单再出新的',
      { docNo: dupBatch.docNo, docId: dupBatch.id });
  }
  const dupRelease = data.releaseDocs.find((d) => d.releaseId === release.id && d.status !== '已撤销');
  if (dupRelease) {
    throw new AppError(409, 'DOC_ALREADY_ISSUED',
      '这条放行记录已经出具过放行单 ' + dupRelease.docNo + '（' + dupRelease.status + '），一张单只对应一条有效记录',
      { docNo: dupRelease.docNo, docId: dupRelease.id });
  }
  const errors = {};
  if (!String(payload.issuedBy || '').trim()) errors.issuedBy = '出具人要填';
  const issuedAt = String(payload.issuedAt || '').trim() || store.nowText();
  if (!TIME_RE.test(issuedAt)) errors.issuedAt = '出具时刻格式要像 2026-09-01 08:00:00';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '放行单没通过校验', errors);
  const doc = {
    id: store.nextId('rd', data.releaseDocs),
    docNo: nextDocNo(data, issuedAt),
    releaseId: release.id,
    batchId: batch.id,
    batchCode: batch.code,
    product: batch.product,
    spec: batch.spec,
    units: Number(batch.units),
    decidedAt: release.decidedAt,
    decider: release.decider,
    mkt: release.mkt,
    longestExcursionMinutes: release.longestExcursionMinutes,
    totalExcursionMinutes: release.totalExcursionMinutes,
    chainGapCount: release.chainGapCount,
    basis: release.basis,
    status: '已出具',
    issuedAt,
    issuedBy: String(payload.issuedBy).trim(),
    sentAt: '',
    sentTo: '',
    receiptStatus: '未发出',
    receiptAt: '',
    voidedAt: '',
    voidedBy: '',
    voidReason: '',
    remark: String(payload.remark || '').trim(),
  };
  data.releaseDocs.push(doc);
  return decorateDoc(data, doc);
}

// 登记发出：已出具 → 已发出，回执进入待回执
function sendDoc(data, id, payload) {
  const doc = findDoc(data, id);
  if (doc.status === '已撤销') throw new AppError(409, 'DOC_VOIDED', '这张单已撤销（' + doc.voidedAt + '），不能登记发出');
  if (doc.status === '已发出') {
    throw new AppError(409, 'DOC_ALREADY_SENT', '这张单已经发出过（' + doc.sentAt + ' 发给 ' + doc.sentTo + '），不能重复登记');
  }
  const errors = {};
  if (!String(payload.sentTo || '').trim()) errors.sentTo = '接收方要填';
  const sentAt = String(payload.sentAt || '').trim() || store.nowText();
  if (!TIME_RE.test(sentAt)) errors.sentAt = '发出时刻格式要像 2026-09-01 08:00:00';
  if (Object.keys(errors).length) throw new AppError(400, 'VALIDATION_FAILED', '发出登记没通过校验', errors);
  doc.sentAt = sentAt;
  doc.sentTo = String(payload.sentTo).trim();
  doc.status = '已发出';
  doc.receiptStatus = '待回执';
  return decorateDoc(data, doc);
}

// 登记回执：只对已发出的单
function receiptDoc(data, id, payload) {
  const doc = findDoc(data, id);
  if (doc.status === '已撤销') throw new AppError(409, 'DOC_VOIDED', '这张单已撤销（' + doc.voidedAt + '），不能登记回执');
  if (doc.status !== '已发出') throw new AppError(409, 'DOC_NOT_SENT', '这张单还没发出，不能登记回执');
  const status = String(payload.receiptStatus || '');
  if (!['已回执', '对方拒收'].includes(status)) {
    throw new AppError(400, 'VALIDATION_FAILED', '回执登记没通过校验', { receiptStatus: '回执状态只能是：已回执、对方拒收' });
  }
  const receiptAt = String(payload.receiptAt || '').trim() || store.nowText();
  if (!TIME_RE.test(receiptAt)) {
    throw new AppError(400, 'VALIDATION_FAILED', '回执登记没通过校验', { receiptAt: '回执时刻格式要像 2026-09-01 08:00:00' });
  }
  doc.receiptStatus = status;
  doc.receiptAt = receiptAt;
  return decorateDoc(data, doc);
}

// 撤销：发出后要改只能走这里，撤销必须写依据，撤销后留痕、可重新出具新单
function voidDoc(data, id, payload) {
  const doc = findDoc(data, id);
  if (doc.status === '已撤销') {
    throw new AppError(409, 'DOC_ALREADY_VOIDED', '这张单已经是撤销状态（' + doc.voidedAt + ' 撤销），不能重复撤销');
  }
  const reason = String(payload.voidReason || payload.reason || '').trim();
  if (!reason) throw new AppError(400, 'VALIDATION_FAILED', '撤销要写依据', { voidReason: '撤销依据不能为空' });
  const voidedAt = String(payload.voidedAt || '').trim() || store.nowText();
  if (!TIME_RE.test(voidedAt)) {
    throw new AppError(400, 'VALIDATION_FAILED', '撤销没通过校验', { voidedAt: '撤销时刻格式要像 2026-09-01 08:00:00' });
  }
  doc.status = '已撤销';
  doc.voidedAt = voidedAt;
  doc.voidedBy = String(payload.voidedBy || '').trim();
  doc.voidReason = reason;
  return decorateDoc(data, doc);
}

// 台账行装饰：每条放行记录带上名下单据的张数与当前有效单状态
function decorateReleaseRow(data, release) {
  const batch = data.batches.find((b) => b.id === release.batchId);
  const docsOf = data.releaseDocs.filter((d) => d.releaseId === release.id);
  const valid = docsOf.filter((d) => d.status !== '已撤销');
  const current = valid.length ? valid[valid.length - 1] : null;
  return Object.assign({}, release, {
    batchCode: batch ? batch.code : '',
    docCount: docsOf.length,
    validDocCount: valid.length,
    voidedDocCount: docsOf.length - valid.length,
    docStatus: current ? current.status : '无单',
    docId: current ? current.id : '',
    docNo: current ? current.docNo : '',
    receiptStatus: current ? current.receiptStatus : '',
  });
}

// 概览计数：单据与回执的条数与状态、对不上的张数
function summaryCounts(data) {
  const all = data.releaseDocs;
  const valid = all.filter((d) => d.status !== '已撤销');
  let mismatch = 0;
  for (const d of valid) if (!reconcileDoc(data, d).ok) mismatch += 1;
  return {
    releaseDocCount: all.length,
    validDocCount: valid.length,
    issuedDocCount: valid.filter((d) => d.status === '已出具').length,
    sentDocCount: valid.filter((d) => d.status === '已发出').length,
    voidedDocCount: all.length - valid.length,
    pendingReceiptCount: valid.filter((d) => d.receiptStatus === '待回执').length,
    receivedDocCount: valid.filter((d) => d.receiptStatus === '已回执').length,
    rejectedReceiptCount: valid.filter((d) => d.receiptStatus === '对方拒收').length,
    docMismatchCount: mismatch,
  };
}

module.exports = {
  DOC_STATUS, RECEIPT_STATUS,
  listDocs, docDetail, issueDoc, sendDoc, receiptDoc, voidDoc,
  reconcileDoc, decorateDoc, decorateReleaseRow, summaryCounts,
};
