'use strict';
// Plain-language status for a part: what's happening now, in words anyone can follow.
const db = require('../db');
const agent = require('./agent');

const TYPICAL = { quick: 3, standard: 8, deep: 20 }; // minutes a run usually takes

// Queue facts for the given parts: how many runs are ahead and which agent is working now.
async function queueContext(parts) {
  const q = agent.queueInfo();
  const ids = parts.filter((p) => p.agent_status === 'queued').map((p) => p.id);
  const ctx = {};
  if (!ids.length) return ctx;
  const runs = await db('agent_runs').whereIn('part_id', ids).where('status', 'running').select('id', 'part_id');
  const running = await db('agent_runs').join('parts', 'parts.id', 'agent_runs.part_id').where('agent_runs.status', 'running').where('parts.agent_status', 'running')
    .orderBy('agent_runs.id').select('parts.agent_name', 'parts.agent_depth', 'parts.agent_progress');
  for (const r of runs) {
    const pos = q.queue.indexOf(r.id);
    if (pos < 0) continue;
    const full = q.active >= q.concurrency;
    const first = running[0];
    const left = first ? Math.max(1, Math.round((TYPICAL[first.agent_depth] || 8) * (100 - (first.agent_progress || 0)) / 100)) : 2;
    ctx[r.part_id] = { ahead: pos + (full ? 1 : 0), blocker: pos === 0 && full && first ? first.agent_name : null, minutes: pos * 4 + left };
  }
  return ctx;
}

function plainStatus(p, ctx) {
  const step = String(p.agent_step || '');
  const pc = p.agent_progress || 0;
  switch (p.agent_status) {
    case 'draft': return 'Ready to launch';
    case 'review': return 'Ready — waiting for you to review';
    case 'accepted': return 'Accepted — in the paper';
    case 'failed': return 'Stopped: ' + (step && step !== 'Stopped' ? step.replace(/\s*[—-]\s*run it again\.?$/i, '') : 'it didn’t finish') + '. Run it again.';
    case 'queued': {
      const c = ctx && ctx[p.id];
      if (!c || !c.ahead) return 'Starting…';
      if (c.blocker) return 'Starts after the ' + c.blocker.replace(/ agent$/i, '') + ' agent finishes (about ' + c.minutes + ' min)';
      return 'Starts after ' + c.ahead + ' other agent' + (c.ahead === 1 ? '' : 's') + ' finish (about ' + c.minutes + ' min)';
    }
    case 'running': {
      let m;
      if ((m = step.match(/Reading full text (\d+)\/(\d+)/))) return 'Reading the full text of ' + m[1] + ' of ' + m[2] + ' papers';
      if ((m = step.match(/batch (\d+) of (\d+)/))) return 'Reading sources (' + m[1] + ' of ' + m[2] + ' batches)';
      if ((m = step.match(/^Searching ([^:]+):/))) return 'Searching ' + m[1] + '…';
      if (pc < 12) return 'Planning what to search for';
      if (pc < 48) return 'Searching papers, books and reports…';
      if (pc < 58) return 'Following citations and checking source quality';
      if (pc < 86) return 'Reading the sources';
      if (pc < 93) return 'Checking where sources agree and disagree';
      return 'Finding research gaps';
    }
    default: return step;
  }
}

function minutesLeft(p) {
  if (p.agent_status !== 'running') return null;
  const total = TYPICAL[p.agent_depth] || 8;
  return Math.max(1, Math.round(total * (100 - (p.agent_progress || 0)) / 100));
}

module.exports = { plainStatus, queueContext, minutesLeft };
