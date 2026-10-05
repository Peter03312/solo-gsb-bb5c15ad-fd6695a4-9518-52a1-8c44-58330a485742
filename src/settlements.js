const express = require('express');
const { db, transaction } = require('./db');
const { badRequest, notFound, forbidden, conflict, wrap } = require('./errors');
const { authRequired } = require('./auth');

/**
 * 演员劳务结算（按到场登记结算）。
 *
 * 核心规则：
 *   - 导演维护每名演员的“每小时费率（分，非负整数）”；费率在结算时取值并冻结进明细。
 *   - 导演选择多个“已关闭（closed）”的到场登记生成一张结算单：
 *       * 已作废（voided）登记不能结算；开放中（open）登记不能结算；
 *       * 关闭后取消日程的登记（schedule_cancelled=1）仍可结算；
 *       * 仅冻结名单中“已签到”者计费；同一登记内兼任多角只产生一条明细；
 *       * 金额 = 登记冻结的 UTC 时段秒数 × 结算时费率 ÷ 3600，逐人逐登记四舍五入到分。
 *   - 无费率、同一请求重复选择登记、或登记已在其他结算单中 -> 整单拒绝，不写入任何数据，
 *     不占用任何登记（占用由 settlement_attendances.attendance_id 唯一索引兜底）。
 *   - 结算单冻结登记、演员、时长、费率与金额；之后调期、改派、替角、费率变更或取消日程均不改写。
 *   - 导演可查看任意整单与合计；演员只能查看本人明细。
 */

const router = express.Router();
router.use(authRequired);

function isNonNegativeInt(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** 逐人四舍五入到分（半数向上）；BigInt 整数运算，避免浮点误差。
 *  floor(d*2n + 1n) 形式：floor((2x+d)/(2d))，余数恰为半分时向上取。 */
function roundCents(durationSeconds, rateCents) {
  const num = BigInt(durationSeconds) * BigInt(rateCents);
  const denom = 3600n;
  return Number((2n * num + denom) / (2n * denom));
}

function sceneBrief(sceneId) {
  const scene = db.prepare('SELECT code, title FROM scenes WHERE id = ?').get(sceneId);
  return { sceneCode: scene?.code ?? null, sceneTitle: scene?.title ?? null };
}

function versionBrief(versionId) {
  const v = db.prepare('SELECT version_no FROM versions WHERE id = ?').get(versionId);
  return { versionId, versionNo: v?.version_no ?? null };
}

function rehearsalName(rehearsalId) {
  const r = db.prepare('SELECT name FROM rehearsals WHERE id = ?').get(rehearsalId);
  return r?.name ?? null;
}

// ---- 费率：导演查看（无费率的演员 rateCents=null）与设置（非负整数） ----
router.get(
  '/actors/rates',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden('仅导演可查看演员费率');
    const actors = db
      .prepare(
        `SELECT u.id AS actor_id, u.username, u.display_name, ar.rate_cents, ar.updated_at
           FROM users u
           LEFT JOIN actor_rates ar ON ar.actor_id = u.id
          WHERE u.role = 'actor'
          ORDER BY u.id`
      )
      .all();
    res.json({
      actors: actors.map((a) => ({
        actorId: a.actor_id,
        actorUsername: a.username,
        actorName: a.display_name,
        rateCents: a.rate_cents ?? null,
        updatedAt: a.updated_at ?? null,
      })),
    });
  })
);

router.put(
  '/actors/:actorId/rate',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden('仅导演可维护演员费率');
    const actorId = Number(req.params.actorId);
    if (!Number.isInteger(actorId)) throw badRequest('演员 id 必须为整数');
    const actor = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'actor'").get(actorId);
    if (!actor) throw notFound('演员不存在');
    const { rateCents } = req.body || {};
    if (!isNonNegativeInt(rateCents)) throw badRequest('费率必须是非负整数（单位：分/小时）');
    db.prepare(
      `INSERT INTO actor_rates (actor_id, rate_cents, updated_by, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(actor_id) DO UPDATE SET rate_cents = excluded.rate_cents,
         updated_by = excluded.updated_by, updated_at = datetime('now')`
    ).run(actorId, rateCents, req.user.id);
    res.json({ ok: true, actor: { actorId, actorName: actor.display_name, rateCents } });
  })
);

/** 明细序列化（导演与演员视图共用；演员视图只在列表内放入本人条目） */
function serializeItem(row) {
  return {
    id: row.id,
    settlementId: row.settlement_id,
    attendanceId: row.attendance_id,
    scheduleId: row.schedule_id,
    rehearsalId: row.rehearsal_id,
    rehearsalName: rehearsalName(row.rehearsal_id),
    sceneId: row.scene_id,
    ...sceneBrief(row.scene_id),
    ...versionBrief(row.version_id),
    startAt: row.start_at,
    endAt: row.end_at,
    durationSeconds: row.duration_seconds,
    actorId: row.actor_id,
    actorName: row.actor_name,
    roles: JSON.parse(row.roles_json || '[]'),
    rateCents: row.rate_cents,
    amountCents: row.amount_cents,
    checkedInAt: row.checked_in_at,
  };
}

function serializeAttendance(row) {
  return {
    id: row.id,
    attendanceId: row.attendance_id,
    scheduleId: row.schedule_id,
    rehearsalId: row.rehearsal_id,
    rehearsalName: rehearsalName(row.rehearsal_id),
    sceneId: row.scene_id,
    ...sceneBrief(row.scene_id),
    ...versionBrief(row.version_id),
    startAt: row.start_at,
    endAt: row.end_at,
    durationSeconds: row.duration_seconds,
    attendanceStatus: row.attendance_status,
    scheduleCancelled: !!row.schedule_cancelled,
    checkedInCount: row.checked_in_count,
  };
}

function listItems(settlementId) {
  return db
    .prepare('SELECT * FROM settlement_items WHERE settlement_id = ? ORDER BY id')
    .all(settlementId)
    .map(serializeItem);
}

/** 按演员汇总（导演视图）：时长合计与金额合计均为该单内该演员各明细之和 */
function summarizeByActor(items) {
  const byActor = new Map();
  for (const it of items) {
    let a = byActor.get(it.actorId);
    if (!a) {
      a = { actorId: it.actorId, actorName: it.actorName, durationSeconds: 0, amountCents: 0, lineCount: 0 };
      byActor.set(it.actorId, a);
    }
    a.durationSeconds += it.durationSeconds;
    a.amountCents += it.amountCents;
    a.lineCount += 1;
  }
  return [...byActor.values()].sort((x, y) => x.actorId - y.actorId);
}

function getSettlementOrThrow(settlementId) {
  const s = db.prepare('SELECT * FROM settlements WHERE id = ?').get(settlementId);
  if (!s) throw notFound('结算单不存在');
  return s;
}

function serializeForDirector(s) {
  const attendanceRows = db
    .prepare('SELECT * FROM settlement_attendances WHERE settlement_id = ? ORDER BY id')
    .all(s.id);
  const items = listItems(s.id);
  return {
    id: s.id,
    note: s.note,
    totalCents: s.total_cents,
    lineCount: items.length,
    attendanceCount: attendanceRows.length,
    createdAt: s.created_at,
    attendances: attendanceRows.map(serializeAttendance),
    items,
    byActor: summarizeByActor(items),
  };
}

function serializeForActor(s, actorId) {
  const all = listItems(s.id);
  const items = all.filter((it) => it.actorId === actorId);
  // 演员只见本人明细所涉及的登记快照（不暴露同单其他登记上的他人信息）
  const attendanceRows = db
    .prepare(
      `SELECT * FROM settlement_attendances
        WHERE settlement_id = ? AND id IN (
          SELECT DISTINCT settlement_attendance_id FROM settlement_items
           WHERE settlement_id = ? AND actor_id = ?
        ) ORDER BY id`
    )
    .all(s.id, s.id, actorId);
  return {
    id: s.id,
    note: s.note,
    createdAt: s.created_at,
    myLineCount: items.length,
    myTotalCents: items.reduce((sum, it) => sum + it.amountCents, 0),
    attendances: attendanceRows.map(serializeAttendance),
    items,
  };
}

function listEntry(s) {
  return {
    id: s.id,
    note: s.note,
    totalCents: s.total_cents,
    lineCount: db.prepare('SELECT COUNT(*) AS n FROM settlement_items WHERE settlement_id = ?').get(s.id).n,
    attendanceCount: db
      .prepare('SELECT COUNT(*) AS n FROM settlement_attendances WHERE settlement_id = ?')
      .get(s.id).n,
    createdAt: s.created_at,
  };
}

// ---- 导演：生成结算单（整单校验，任一不满足整体拒绝且不占用登记） ----
router.post(
  '/settlements',
  wrap((req, res) => {
    if (req.user.role !== 'director') throw forbidden('仅导演可生成结算单');
    const { attendanceIds, note } = req.body || {};
    if (!Array.isArray(attendanceIds) || attendanceIds.length === 0) {
      throw badRequest('attendanceIds 必须为非空数组（至少选择一个已关闭登记）');
    }
    if (!attendanceIds.every((x) => Number.isInteger(x) && x > 0)) {
      throw badRequest('attendanceIds 必须全部为正整数');
    }
    if (note !== undefined && typeof note !== 'string') throw badRequest('note 必须为字符串');

    // 同一请求内重复选择 -> 整单拒绝
    const dup = attendanceIds.filter((id) => attendanceIds.indexOf(id) !== attendanceIds.lastIndexOf(id));
    if (dup.length) {
      throw badRequest(`批次中存在重复选择的登记 #${dup[0]}`, { duplicates: [...new Set(dup)] });
    }

    // 读校验全部通过后才在一个事务内写入；任何抛错整体回滚，不占用登记
    let settlementId;
    try {
      settlementId = transaction(() => {
      const sessions = [];
      for (const attendanceId of attendanceIds) {
        const session = db.prepare('SELECT * FROM attendance_sessions WHERE id = ?').get(attendanceId);
        if (!session) {
          throw notFound(`到场登记 #${attendanceId} 不存在`);
        }
        if (session.status === 'voided') {
          throw badRequest(`登记 #${attendanceId} 已作废，不能结算（已作废登记不计劳务）`, {
            attendanceId,
            status: session.status,
          });
        }
        if (session.status !== 'closed') {
          throw badRequest(`登记 #${attendanceId} 尚未关闭，只有已关闭登记才能结算`, {
            attendanceId,
            status: session.status,
          });
        }
        const occupied = db
          .prepare('SELECT settlement_id FROM settlement_attendances WHERE attendance_id = ?')
          .get(attendanceId);
        if (occupied) {
          throw conflict(
            'ATTENDANCE_ALREADY_SETTLED',
            `登记 #${attendanceId} 已在结算单 #${occupied.settlement_id} 中结算，不能重复结算`,
            { attendanceId, settlementId: occupied.settlement_id }
          );
        }
        sessions.push(session);
      }

      // 仅冻结名单中已签到者计费；结算时取费率快照
      const checkedIn = db.prepare(
        'SELECT * FROM attendance_roster WHERE session_id = ? AND checked_in_at IS NOT NULL ORDER BY id'
      );
      const getRate = db.prepare('SELECT rate_cents FROM actor_rates WHERE actor_id = ?');
      const actorNameStmt = db.prepare('SELECT display_name FROM users WHERE id = ?');

      // 先全部读校验并算好金额，再落库；表触发器禁止生成后 UPDATE，故合计在 INSERT 时一次写定
      const planned = []; // {session, durationSeconds, rows: [{roster, rateCents, amountCents}]}
      let total = 0n;
      for (const session of sessions) {
        const durationSeconds = Math.round(
          (new Date(session.end_at).getTime() - new Date(session.start_at).getTime()) / 1000
        );
        const rosterRows = checkedIn.all(session.id);
        const rows = rosterRows.map((r) => {
          const rateRow = getRate.get(r.actor_id);
          if (!rateRow) {
            const u = actorNameStmt.get(r.actor_id);
            throw conflict(
              'MISSING_ACTOR_RATE',
              `演员「${u?.display_name ?? r.actor_id}」尚未设置每小时费率，请先维护费率后再结算`,
              { attendanceId: session.id, actorId: r.actor_id }
            );
          }
          const amountCents = roundCents(durationSeconds, rateRow.rate_cents);
          total += BigInt(amountCents);
          return { roster: r, rateCents: rateRow.rate_cents, amountCents };
        });
        planned.push({ session, durationSeconds, rows });
      }

      const id = db
        .prepare('INSERT INTO settlements (note, total_cents, created_by) VALUES (?, ?, ?)')
        .run(note ? String(note) : '', Number(total), req.user.id).lastInsertRowid;

      const insAtt = db.prepare(
        `INSERT INTO settlement_attendances
           (settlement_id, attendance_id, schedule_id, rehearsal_id, scene_id, version_id,
            start_at, end_at, duration_seconds, attendance_status, schedule_cancelled, checked_in_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insItem = db.prepare(
        `INSERT INTO settlement_items
           (settlement_id, settlement_attendance_id, attendance_id, schedule_id, rehearsal_id, scene_id,
            version_id, actor_id, actor_name, roles_json, start_at, end_at, duration_seconds,
            rate_cents, amount_cents, checked_in_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      for (const { session, durationSeconds, rows } of planned) {
        const attLinkId = insAtt
          .run(
            id,
            session.id,
            session.schedule_id,
            session.rehearsal_id,
            session.scene_id,
            session.version_id,
            session.start_at,
            session.end_at,
            durationSeconds,
            session.status,
            session.schedule_cancelled,
            rows.length
          )
          .lastInsertRowid;
        // 同一登记内一人兼任多角：attendance_roster 对 (session_id, actor_id) 唯一，天然只算一次
        for (const { roster: r, rateCents, amountCents } of rows) {
          insItem.run(
            id,
            attLinkId,
            session.id,
            session.schedule_id,
            session.rehearsal_id,
            session.scene_id,
            session.version_id,
            r.actor_id,
            actorNameStmt.get(r.actor_id)?.display_name ?? `演员#${r.actor_id}`,
            r.roles_json,
            session.start_at,
            session.end_at,
            durationSeconds,
            rateCents,
            amountCents,
            r.checked_in_at
          );
        }
      }

      return id;
      });
    } catch (e) {
      // SQLite UNIQUE 冲突（并发下另一请求抢先占用登记）：整单已回滚，转成业务冲突
      if (e && e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw conflict('ATTENDANCE_ALREADY_SETTLED', '登记已被其他结算单占用，请刷新后重试；本次未占用任何登记');
      }
      throw e;
    }

    res.status(201).json({ settlement: serializeForDirector(getSettlementOrThrow(settlementId)) });
  })
);

// ---- 结算单列表：导演见全部；演员只列含本人明细的结算单 ----
router.get(
  '/settlements',
  wrap((req, res) => {
    if (req.user.role === 'director') {
      const rows = db.prepare('SELECT * FROM settlements ORDER BY id DESC').all();
      return res.json({ settlements: rows.map(listEntry) });
    }
    const rows = db
      .prepare(
        `SELECT DISTINCT s.* FROM settlements s
           JOIN settlement_items i ON i.settlement_id = s.id
          WHERE i.actor_id = ?
          ORDER BY s.id DESC`
      )
      .all(req.user.id);
    res.json({
      // 演员列表不含整单合计，仅给本人条目数与本人合计
      settlements: rows.map((s) => {
        const mine = db
          .prepare('SELECT COALESCE(SUM(amount_cents),0) AS total, COUNT(*) AS n FROM settlement_items WHERE settlement_id = ? AND actor_id = ?')
          .get(s.id, req.user.id);
        const e = listEntry(s);
        delete e.totalCents;
        return { ...e, myTotalCents: mine.total, myLineCount: mine.n };
      }),
    });
  })
);

// ---- 结算单详情：导演见整单与合计；演员仅本人明细（无本人明细 403） ----
router.get(
  '/settlements/:settlementId',
  wrap((req, res) => {
    const s = getSettlementOrThrow(Number(req.params.settlementId));
    if (req.user.role === 'director') {
      return res.json({ settlement: serializeForDirector(s) });
    }
    const mine = db
      .prepare('SELECT COUNT(*) AS n FROM settlement_items WHERE settlement_id = ? AND actor_id = ?')
      .get(s.id, req.user.id);
    if (mine.n === 0) throw forbidden('该结算单中没有你的劳务明细');
    res.json({ settlement: serializeForActor(s, req.user.id) });
  })
);

module.exports = { router, roundCents };
