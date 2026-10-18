(function (root) {
  'use strict';
  const number = v => typeof v === 'number' && Number.isFinite(v);
  function selectedLimits(account, bucket = 'auto') {
    if (bucket !== 'auto') return account.buckets?.find(b => b.key === bucket) || { primary: null, secondary: null };
    return account.limits || { primary: null, secondary: null };
  }
  function remaining(window) {
    return number(window?.usedPercent) ? Math.max(0, Math.min(100, 100 - window.usedPercent)) : null;
  }
  function analyze(state, now = Date.now()) {
    const { reserve = 10, strategy = 'balanced', bucket = 'auto' } = state.settings || {};
    const identities = new Map();
    for (const a of state.accounts || []) {
      if (a.source !== 'codex' || !a.email) continue;
      const email = a.email.toLowerCase().trim(), prior = identities.get(email);
      if (!prior || Date.parse(a.updatedAt || '') > Date.parse(prior.updatedAt || '') || (!prior.connected && a.connected)) identities.set(email, a);
    }
    const events = [];
    const bucketMap = new Map();
    const ranked = (state.accounts || []).map(account => {
      for (const b of account.buckets || []) bucketMap.set(b.key, { key: b.key, label: b.label });
      const limits = selectedLimits(account, bucket);
      const shortRemaining = remaining(limits.primary), weeklyRemaining = remaining(limits.secondary);
      const shortResetDue = number(limits.primary?.resetsAt) && limits.primary.resetsAt * 1000 <= now;
      const weeklyResetDue = number(limits.secondary?.resetsAt) && limits.secondary.resetsAt * 1000 <= now;
      const age = now - Date.parse(account.updatedAt || '');
      const stale = !Number.isFinite(age) || age < -60000 || age > (account.source === 'codex' ? 15 * 60000 : 24 * 3600000);
      const identity = account.source === 'codex' && account.email ? account.email.toLowerCase().trim() : null;
      const duplicate = identity && identities.get(identity) !== account;
      for (const [kind, w] of [['short', limits.primary], ['weekly', limits.secondary]]) {
        if (number(w?.resetsAt) && w.resetsAt * 1000 > now) events.push({ accountId: account.id, label: account.label, kind, at: w.resetsAt });
      }
      let reason = '', eligible = true;
      if (duplicate) reason = 'Duplicate account';
      else if (account.error) reason = account.error;
      else if (account.source === 'codex' && !account.connected) reason = 'Sign in required';
      else if (shortRemaining === null || weeklyRemaining === null) reason = bucket !== 'auto' ? 'No complete limits for this pool' : 'Add usage or sign in';
      else if (shortResetDue || weeklyResetDue) reason = 'Reset due · refresh usage';
      else if (stale) reason = 'Usage is stale · refresh';
      else if (shortRemaining <= reserve || weeklyRemaining <= reserve) reason = shortRemaining === 0 || weeklyRemaining === 0 ? 'Allowance exhausted' : 'Below your reserve';
      if (reason) eligible = false;
      const timeRatio = w => number(w?.resetsAt) && number(w?.windowDurationMins) && w.windowDurationMins > 0 ? Math.max(0, Math.min(1, (w.resetsAt * 1000 - now) / (w.windowDurationMins * 60000))) : 1;
      const urgency = 1 - timeRatio(limits.primary);
      const surplus = Math.max(0, (weeklyRemaining || 0) - timeRatio(limits.secondary) * 100);
      let score = 0;
      if (eligible) {
        score = strategy === 'capacity' ? 0.55 * shortRemaining + 0.45 * weeklyRemaining
          : strategy === 'reset' ? urgency * 65 + 0.2 * shortRemaining + 0.15 * weeklyRemaining
          : 0.5 * shortRemaining + 0.25 * weeklyRemaining + 0.15 * urgency * shortRemaining + 0.1 * surplus;
        reason = strategy === 'capacity' ? 'Most available headroom' : strategy === 'reset' ? 'Use allowance before its next reset' : surplus > 10 ? 'Weekly headroom above elapsed-cycle pace' : 'Available headroom with reset priority';
      }
      return { account, score, eligible, reason, shortRemaining, weeklyRemaining, shortResetDue, weeklyResetDue, stale };
    }).sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || a.account.label.localeCompare(b.account.label));
    return { ranked, recommended: ranked.find(r => r.eligible) || null, readyCount: ranked.filter(r => r.eligible).length, knownCount: ranked.filter(r => r.shortRemaining !== null && r.weeklyRemaining !== null).length, events: events.sort((a,b) => a.at - b.at), bucketKeys: [...bucketMap.values()] };
  }
  function formatDuration(seconds) {
    if (!number(seconds)) return '--';
    if (seconds <= 0) return 'Due now';
    const mins = Math.ceil(seconds / 60), days = Math.floor(mins / 1440), hours = Math.floor(mins % 1440 / 60);
    return days ? `${days}d ${hours}h` : hours ? `${hours}h ${mins % 60}m` : `${mins}m`;
  }
  root.QuotaLogic = { analyze, selectedLimits, remaining, formatDuration };
})(typeof globalThis !== 'undefined' ? globalThis : window);
