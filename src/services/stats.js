'use strict';

// Start of "today" in the store's time zone, returned as a UTC ISO string.
function startOfDayIso(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now).reduce((a, p) => ({ ...a, [p.type]: p.value }), {});
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  const offsetMs = asUtc - Math.floor(now.getTime() / 1000) * 1000;
  const midnightLocalAsUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day);
  return new Date(midnightLocalAsUtc - offsetMs).toISOString();
}

// Item-level mistakes (affect picking accuracy).
const WRONG_ITEM_RESULTS = ['WRONG_PRODUCT', 'UNKNOWN_BARCODE', 'AMBIGUOUS_BARCODE'];
// Every mistake the system blocked, including wrong order slips.
const WRONG_RESULTS = [...WRONG_ITEM_RESULTS, 'OTHER_ORDER_BARCODE', 'ORDER_RESCAN_MISMATCH'];

function createStatsService({ db, config }) {
  async function today(shopId, { pendingOrders = null } = {}) {
    const since = startOfDayIso(config.timezone);

    const packed = await db('picking_sessions')
      .where({ shop_id: shopId, status: 'packed' })
      .where('completed_at', '>=', since)
      .select('picker_id', 'duration_seconds', 'expected_qty');

    const events = await db('scan_events')
      .where({ shop_id: shopId })
      .where('created_at', '>=', since)
      .select('picker_id', 'result');

    const count = (r) => events.filter((e) => e.result === r).length;
    const correct = count('CORRECT');
    const wrong = events.filter((e) => WRONG_RESULTS.includes(e.result)).length;
    const wrongItems = events.filter((e) => WRONG_ITEM_RESULTS.includes(e.result)).length;
    const extra = count('EXTRA_ITEM');
    const attempts = correct + wrongItems + extra;
    const durations = packed.map((p) => p.duration_seconds).filter((d) => d != null);

    const users = await db('users').where({ shop_id: shopId }).select('id', 'display_name', 'role', 'active');
    const pickers = users.map((u) => {
      const mine = packed.filter((p) => p.picker_id === u.id);
      const myEv = events.filter((e) => e.picker_id === u.id);
      const d = mine.map((p) => p.duration_seconds).filter((x) => x != null);
      const myCorrect = myEv.filter((e) => e.result === 'CORRECT').length;
      const myWrong = myEv.filter((e) => WRONG_RESULTS.includes(e.result)).length;
      const myWrongItems = myEv.filter((e) => WRONG_ITEM_RESULTS.includes(e.result)).length;
      const myExtra = myEv.filter((e) => e.result === 'EXTRA_ITEM').length;
      return {
        pickerId: u.id,
        name: u.display_name,
        role: u.role,
        ordersPicked: mine.length,
        itemsPicked: myCorrect,
        wrongScans: myWrong,
        extraScans: myExtra,
        accuracy: myCorrect + myWrongItems + myExtra ? Math.round((myCorrect / (myCorrect + myWrongItems + myExtra)) * 1000) / 10 : null,
        avgPickSeconds: d.length ? Math.round(d.reduce((a, b) => a + b, 0) / d.length) : null,
      };
    }).filter((p) => p.ordersPicked || p.itemsPicked || p.wrongScans || p.extraScans);

    return {
      since,
      ordersPicked: packed.length,
      ordersPending: pendingOrders,
      itemsScanned: correct,
      wrongScansPrevented: wrong + extra,
      wrongProductScans: wrong,
      extraScansPrevented: extra,
      accuracy: attempts ? Math.round((correct / attempts) * 1000) / 10 : null,
      avgPickSeconds: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      pickers,
    };
  }

  return { today };
}

module.exports = { createStatsService, startOfDayIso };
