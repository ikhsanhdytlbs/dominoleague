// Domino League Calculation & Business Logic Engine
// Sesuai Spesifikasi Lengkap Domino League v1.0

export const DEFAULT_PLAYERS = [
  { player_id: "PL01", display_name: "Andi", is_active: true },
  { player_id: "PL02", display_name: "Budi", is_active: true },
  { player_id: "PL03", display_name: "Candra", is_active: true },
  { player_id: "PL04", display_name: "Dedi", is_active: true },
  { player_id: "PL05", display_name: "Eko", is_active: true },
  { player_id: "PL06", display_name: "Fajar", is_active: true },
  { player_id: "PL07", display_name: "Gilang", is_active: true },
  { player_id: "PL08", display_name: "Hendra", is_active: true },
  { player_id: "PL09", display_name: "Iwan", is_active: true },
  { player_id: "PL10", display_name: "Joko", is_active: true }
];

export const DEFAULT_SETTINGS = {
  min_games_champion: 10,
  min_games_rates: 10,
  min_sessions_worst_record: 3,
  min_games_consistent: 10,
  min_sessions_consistent: 3,
  league_name: "Domino League Indonesia",
  organizer_name: "Komite Domino League",
  auto_sync_sheets: false,
  sheets_webhook_url: ""
};

/**
 * Menghitung persentil dengan metode average rank
 */
export function calculatePercentiles(values) {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [50];
  
  // Periksa jika semua nilai sama
  const allEqual = values.every(v => v === values[0]);
  if (allEqual) {
    return values.map(() => 50);
  }
  
  return values.map(val => {
    let countLess = 0;
    let countEqual = 0;
    for (let i = 0; i < n; i++) {
      if (values[i] < val) countLess++;
      else if (values[i] === val) countEqual++;
    }
    // Formula percentile rank standar (average rank)
    const rank = countLess + (countEqual - 1) / 2;
    return (rank / (n - 1)) * 100;
  });
}

/**
 * Menghitung seluruh statistik akumulatif & rasio pemain untuk suatu season
 */
export function calculateSeasonStats(seasonId, players, matches, lossEvents, specialEvents, settings = DEFAULT_SETTINGS) {
  const seasonMatches = matches.filter(m => m.season_id === seasonId);
  const totalSeasonMatches = seasonMatches.length;
  
  // Kumpulkan statistik dasar tiap pemain
  const playerStats = players.map(p => {
    // Game yang diikuti pemain
    const pMatches = seasonMatches.filter(m => m.players.includes(p.player_id));
    const totalMatches = pMatches.length;
    
    // Sesi unik yang diikuti pemain
    const uniqueSessions = new Set(pMatches.map(m => m.session_id));
    const totalSessions = uniqueSessions.size;
    
    // Match IDs yang diikuti
    const matchIds = new Set(pMatches.map(m => m.match_id));
    
    // Total Kalah di season ini
    const pLosses = lossEvents.filter(le => le.player_id === p.player_id && matchIds.has(le.match_id));
    const totalLoss = pLosses.reduce((sum, item) => sum + (Number(item.loss_count) || 0), 0);
    
    // Total Ratus di season ini
    const pS100 = specialEvents.filter(se => se.player_id === p.player_id && se.event_type === "S100" && matchIds.has(se.match_id));
    const totalS100 = pS100.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
    
    // Total Ribu di season ini
    const pS1000 = specialEvents.filter(se => se.player_id === p.player_id && se.event_type === "S1000" && matchIds.has(se.match_id));
    const totalS1000 = pS1000.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
    
    // Rasio (per 100 game)
    const s100Rate = totalMatches > 0 ? (totalS100 / totalMatches) * 100 : 0;
    const s1000Rate = totalMatches > 0 ? (totalS1000 / totalMatches) * 100 : 0;
    const lossRate = totalMatches > 0 ? (totalLoss / totalMatches) * 100 : 0;
    const participationRate = totalSeasonMatches > 0 ? (totalMatches / totalSeasonMatches) * 100 : 0;
    
    // Worst Record per sesi di season ini
    const sessionLossMap = {};
    pMatches.forEach(m => {
      const sId = m.session_id;
      if (!sessionLossMap[sId]) {
        sessionLossMap[sId] = { sessionId: sId, date: m.played_at || "", lossCount: 0 };
      }
    });
    pLosses.forEach(le => {
      const m = pMatches.find(pm => pm.match_id === le.match_id);
      if (m && sessionLossMap[m.session_id]) {
        sessionLossMap[m.session_id].lossCount += (Number(le.loss_count) || 0);
        if (m.played_at && !sessionLossMap[m.session_id].date) {
          sessionLossMap[m.session_id].date = m.played_at;
        }
      }
    });
    
    let worstRecord = { count: 0, sessionId: "-", date: "-" };
    Object.values(sessionLossMap).forEach(s => {
      if (s.lossCount >= worstRecord.count) {
        worstRecord = { count: s.lossCount, sessionId: s.sessionId, date: s.date };
      }
    });
    
    // Kelayakan ambang batas
    const eligibleChampion = totalMatches >= (settings.min_games_champion || 10);
    const eligibleWorstRecord = totalSessions >= (settings.min_sessions_worst_record || 3);
    const eligibleConsistent = totalMatches >= (settings.min_games_consistent || 10) && totalSessions >= (settings.min_sessions_consistent || 3);
    
    return {
      player_id: p.player_id,
      display_name: p.display_name,
      is_active: p.is_active,
      total_matches: totalMatches,
      total_sessions: totalSessions,
      total_loss: totalLoss,
      total_s100: totalS100,
      total_s1000: totalS1000,
      s100_rate: Number(s100Rate.toFixed(2)),
      s1000_rate: Number(s1000Rate.toFixed(2)),
      loss_rate: Number(lossRate.toFixed(2)),
      participation_rate: Number(participationRate.toFixed(1)),
      worst_record: worstRecord,
      session_loss_map: sessionLossMap,
      eligible_champion: eligibleChampion,
      eligible_worst_record: eligibleWorstRecord,
      eligible_consistent: eligibleConsistent,
      performance_index: 0,
      percentile_s100: 0,
      percentile_s1000: 0,
      percentile_loss: 0
    };
  });
  
  // Hitung Performance Index Domino Champion untuk pemain yang memenuhi syarat
  const eligiblePlayers = playerStats.filter(p => p.eligible_champion);
  
  if (eligiblePlayers.length >= 2) {
    const s100Rates = eligiblePlayers.map(p => p.s100_rate);
    const s1000Rates = eligiblePlayers.map(p => p.s1000_rate);
    const lossRates = eligiblePlayers.map(p => p.loss_rate);
    
    const pctS100 = calculatePercentiles(s100Rates);
    const pctS1000 = calculatePercentiles(s1000Rates);
    const pctLoss = calculatePercentiles(lossRates);
    
    eligiblePlayers.forEach((p, idx) => {
      p.percentile_s100 = Number(pctS100[idx].toFixed(2));
      p.percentile_s1000 = Number(pctS1000[idx].toFixed(2));
      p.percentile_loss = Number(pctLoss[idx].toFixed(2));
      
      // Rumus: (Percentile_Ratus + Percentile_Ribu + (100 - Percentile_Loss)) / 3
      const perfIndex = (p.percentile_s100 + p.percentile_s1000 + (100 - p.percentile_loss)) / 3;
      p.performance_index = Number(perfIndex.toFixed(2));
    });
  } else if (eligiblePlayers.length === 1) {
    // Jika hanya 1 pemain memenuhi syarat, tandai data pembanding belum cukup
    eligiblePlayers[0].performance_index = 50.00;
  }
  
  return {
    totalSeasonMatches,
    playerStats: playerStats.sort((a, b) => b.performance_index - a.performance_index)
  };
}

/**
 * Menghitung Standar Deviasi Performance Index per sesi untuk Most Consistent Player
 */
export function calculateConsistency(playerStats, seasonMatches, lossEvents, specialEvents, settings) {
  const eligiblePlayers = playerStats.filter(p => p.eligible_consistent);
  const consistencyResults = [];
  
  eligiblePlayers.forEach(player => {
    // Ambil semua sesi yang diikuti pemain
    const pSessions = Object.keys(player.session_loss_map);
    const sessionIndexes = [];
    
    pSessions.forEach(sessionId => {
      const sesMatches = seasonMatches.filter(m => m.session_id === sessionId && m.players.includes(player.player_id));
      if (sesMatches.length === 0) return;
      
      const sesMatchIds = new Set(sesMatches.map(m => m.match_id));
      const sesLoss = lossEvents
        .filter(le => le.player_id === player.player_id && sesMatchIds.has(le.match_id))
        .reduce((sum, item) => sum + (Number(item.loss_count) || 0), 0);
      
      const sesS100 = specialEvents
        .filter(se => se.player_id === player.player_id && se.event_type === "S100" && sesMatchIds.has(se.match_id))
        .reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
      
      const sesS1000 = specialEvents
        .filter(se => se.player_id === player.player_id && se.event_type === "S1000" && sesMatchIds.has(se.match_id))
        .reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
      
      const sRate = (sesS100 / sesMatches.length) * 100;
      const mRate = (sesS1000 / sesMatches.length) * 100;
      const lRate = (sesLoss / sesMatches.length) * 100;
      
      // Indeks performa sesi sederhana = sRate + (2 * mRate) - lRate
      sessionIndexes.push(sRate + 2 * mRate - lRate);
    });
    
    if (sessionIndexes.length >= 2) {
      const mean = sessionIndexes.reduce((a, b) => a + b, 0) / sessionIndexes.length;
      const variance = sessionIndexes.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / sessionIndexes.length;
      const stdDev = Math.sqrt(variance);
      consistencyResults.push({
        player_id: player.player_id,
        display_name: player.display_name,
        std_dev: Number(stdDev.toFixed(2)),
        sessions_count: sessionIndexes.length
      });
    }
  });
  
  return consistencyResults.sort((a, b) => a.std_dev - b.std_dev);
}

/**
 * Menghitung 8 Penghargaan Season
 */
export function calculateSeasonAwards(playerStats, consistencyList, settings) {
  const awards = [];
  
  // 1. Domino Champion (Performance Index tertinggi, min 10 game)
  const eligibleChamps = playerStats.filter(p => p.eligible_champion);
  if (eligibleChamps.length >= 2) {
    const highestIdx = Math.max(...eligibleChamps.map(p => p.performance_index));
    const champions = eligibleChamps.filter(p => p.performance_index === highestIdx);
    awards.push({
      id: "domino_champion",
      title: "Domino Champion",
      desc: "Pemain terbaik berdasarkan gabungan Ratus Rate, Ribu Rate, dan Loss Rate.",
      icon: "Trophy",
      winners: champions.map(c => ({
        player_id: c.player_id,
        name: c.display_name,
        value: `${c.performance_index} pts`,
        extra: `Ratus: ${c.s100_rate} | Ribu: ${c.s1000_rate} | Loss: ${c.loss_rate}`
      })),
      is_tie: champions.length > 1,
      eligible: true
    });
  } else {
    awards.push({
      id: "domino_champion",
      title: "Domino Champion",
      desc: "Performance Index tertinggi (Min. 10 game)",
      icon: "Trophy",
      winners: [],
      is_tie: false,
      eligible: false,
      note: "Belum cukup pemain yang memenuhi syarat minimal 10 pertandingan."
    });
  }
  
  // 2. Ratus Master (Ratus Rate tertinggi, min 10 game)
  if (eligibleChamps.length > 0) {
    const maxRate = Math.max(...eligibleChamps.map(p => p.s100_rate));
    let candidates = eligibleChamps.filter(p => p.s100_rate === maxRate);
    if (candidates.length > 1) {
      // Tie-break: total Ratus terbanyak
      const maxCount = Math.max(...candidates.map(p => p.total_s100));
      candidates = candidates.filter(p => p.total_s100 === maxCount);
    }
    awards.push({
      id: "s100_master",
      title: "Ratus Master",
      desc: "Spesialis Ratus: Rasio Ratus tertinggi per 100 game.",
      icon: "Zap",
      winners: candidates.map(c => ({
        player_id: c.player_id,
        name: c.display_name,
        value: `${c.s100_rate}%`,
        extra: `Total: ${c.total_s100} kali (${c.total_matches} game)`
      })),
      is_tie: candidates.length > 1,
      eligible: true
    });
  } else {
    awards.push({
      id: "s100_master",
      title: "Ratus Master",
      desc: "Ratus Rate tertinggi (Min. 10 game)",
      icon: "Zap",
      winners: [],
      eligible: false,
      note: "Belum ada pemain memenuhi syarat."
    });
  }
  
  // 3. Ribu Master (Ribu Rate tertinggi, min 10 game)
  if (eligibleChamps.length > 0) {
    const maxRate = Math.max(...eligibleChamps.map(p => p.s1000_rate));
    let candidates = eligibleChamps.filter(p => p.s1000_rate === maxRate);
    if (candidates.length > 1) {
      // Tie-break: total Ribu terbanyak
      const maxCount = Math.max(...candidates.map(p => p.total_s1000));
      candidates = candidates.filter(p => p.total_s1000 === maxCount);
    }
    awards.push({
      id: "s1000_master",
      title: "Ribu Master",
      desc: "Spesialis Ribu: Rasio Ribu tertinggi per 100 game.",
      icon: "Crown",
      winners: candidates.map(c => ({
        player_id: c.player_id,
        name: c.display_name,
        value: `${c.s1000_rate}%`,
        extra: `Total: ${c.total_s1000} kali (${c.total_matches} game)`
      })),
      is_tie: candidates.length > 1,
      eligible: true
    });
  } else {
    awards.push({
      id: "s1000_master",
      title: "Ribu Master",
      desc: "Ribu Rate tertinggi (Min. 10 game)",
      icon: "Crown",
      winners: [],
      eligible: false,
      note: "Belum ada pemain memenuhi syarat."
    });
  }
  
  // 4. Most Unlucky Player (Total kekalahan kumulatif tertinggi, min 10 game)
  if (eligibleChamps.length > 0) {
    const maxLoss = Math.max(...eligibleChamps.map(p => p.total_loss));
    const candidates = eligibleChamps.filter(p => p.total_loss === maxLoss);
    awards.push({
      id: "most_unlucky",
      title: "Most Unlucky Player",
      desc: "Pemain dengan akumulasi catatan kalah terbanyak.",
      icon: "Flame",
      winners: candidates.map(c => ({
        player_id: c.player_id,
        name: c.display_name,
        value: `${c.total_loss} kalah`,
        extra: `Dari total ${c.total_matches} pertandingan`
      })),
      is_tie: candidates.length > 1,
      eligible: true
    });
  } else {
    awards.push({
      id: "most_unlucky",
      title: "Most Unlucky Player",
      desc: "Total kekalahan tertinggi (Min. 10 game)",
      icon: "Flame",
      winners: [],
      eligible: false,
      note: "Belum ada pemain memenuhi syarat."
    });
  }
  
  // 5. Worst Record (Kekalahan terbanyak dalam 1 sesi, min 3 sesi)
  const eligibleWorst = playerStats.filter(p => p.eligible_worst_record);
  if (eligibleWorst.length > 0) {
    const maxSessionLoss = Math.max(...eligibleWorst.map(p => p.worst_record.count));
    const candidates = eligibleWorst.filter(p => p.worst_record.count === maxSessionLoss);
    awards.push({
      id: "worst_record",
      title: "Worst Record",
      desc: "Kekalahan terbanyak yang pernah dialami dalam 1 kali duduk/sesi.",
      icon: "Skull",
      winners: candidates.map(c => ({
        player_id: c.player_id,
        name: c.display_name,
        value: `${c.worst_record.count} kalah / sesi`,
        extra: `Sesi: ${c.worst_record.sessionId} (${c.worst_record.date})`
      })),
      is_tie: candidates.length > 1,
      eligible: true
    });
  } else {
    awards.push({
      id: "worst_record",
      title: "Worst Record",
      desc: "Kalah terbanyak dalam 1 sesi (Min. 3 sesi)",
      icon: "Skull",
      winners: [],
      eligible: false,
      note: "Belum ada pemain memenuhi syarat 3 sesi."
    });
  }
  
  // 6. Lowest Performance (Loss Rate tertinggi, min 10 game)
  if (eligibleChamps.length > 0) {
    const maxLossRate = Math.max(...eligibleChamps.map(p => p.loss_rate));
    let candidates = eligibleChamps.filter(p => p.loss_rate === maxLossRate);
    if (candidates.length > 1) {
      // Tie-break: total game lebih banyak
      const maxGames = Math.max(...candidates.map(p => p.total_matches));
      candidates = candidates.filter(p => p.total_matches === maxGames);
    }
    awards.push({
      id: "lowest_performance",
      title: "Lowest Performance",
      desc: "Rasio kekalahan per pertandingan tertinggi.",
      icon: "TrendingDown",
      winners: candidates.map(c => ({
        player_id: c.player_id,
        name: c.display_name,
        value: `${c.loss_rate}%`,
        extra: `${c.total_loss} kalah dari ${c.total_matches} game`
      })),
      is_tie: candidates.length > 1,
      eligible: true
    });
  } else {
    awards.push({
      id: "lowest_performance",
      title: "Lowest Performance",
      desc: "Loss Rate tertinggi (Min. 10 game)",
      icon: "TrendingDown",
      winners: [],
      eligible: false,
      note: "Belum ada pemain memenuhi syarat."
    });
  }
  
  // 7. Most Active Player (Total game terbanyak, tanpa syarat minimal)
  const allWithGames = playerStats.filter(p => p.total_matches > 0);
  if (allWithGames.length > 0) {
    const maxMatches = Math.max(...allWithGames.map(p => p.total_matches));
    const candidates = allWithGames.filter(p => p.total_matches === maxMatches);
    awards.push({
      id: "most_active",
      title: "Most Active Player",
      desc: "Pemain paling rajin dengan total keikutsertaan game terbanyak.",
      icon: "Activity",
      winners: candidates.map(c => ({
        player_id: c.player_id,
        name: c.display_name,
        value: `${c.total_matches} game`,
        extra: `Partisipasi: ${c.participation_rate}% musim ini`
      })),
      is_tie: candidates.length > 1,
      eligible: true
    });
  } else {
    awards.push({
      id: "most_active",
      title: "Most Active Player",
      desc: "Total game terbanyak",
      icon: "Activity",
      winners: [],
      eligible: false,
      note: "Belum ada pertandingan tercatat."
    });
  }
  
  // 8. Most Consistent Player (Standar deviasi indeks performa sesi terkecil)
  if (consistencyList && consistencyList.length > 0) {
    const minStdDev = Math.min(...consistencyList.map(c => c.std_dev));
    const candidates = consistencyList.filter(c => c.std_dev === minStdDev);
    awards.push({
      id: "most_consistent",
      title: "Most Consistent Player",
      desc: "Pemain dengan performa antar-sesi paling stabil.",
      icon: "ShieldCheck",
      winners: candidates.map(c => ({
        player_id: c.player_id,
        name: c.display_name,
        value: `σ = ${c.std_dev}`,
        extra: `Diuji pada ${c.sessions_count} sesi`
      })),
      is_tie: candidates.length > 1,
      eligible: true
    });
  } else {
    awards.push({
      id: "most_consistent",
      title: "Most Consistent Player",
      desc: "Variasi performa per sesi paling kecil (Min. 10 game & 3 sesi)",
      icon: "ShieldCheck",
      winners: [],
      eligible: false,
      note: "Belum cukup data sesi untuk mengukur variasi performa."
    });
  }
  
  return awards;
}

/**
 * Head-to-Head Comparison
 */
export function calculateHeadToHead(playerAId, playerBId, matches, lossEvents, specialEvents) {
  // Hanya game yang diikuti KEDUANYA bersamaan
  const sharedMatches = matches.filter(m => m.players.includes(playerAId) && m.players.includes(playerBId));
  const sharedMatchIds = new Set(sharedMatches.map(m => m.match_id));
  
  const aLosses = lossEvents
    .filter(le => le.player_id === playerAId && sharedMatchIds.has(le.match_id))
    .reduce((sum, item) => sum + (Number(item.loss_count) || 0), 0);
  
  const bLosses = lossEvents
    .filter(le => le.player_id === playerBId && sharedMatchIds.has(le.match_id))
    .reduce((sum, item) => sum + (Number(item.loss_count) || 0), 0);
  
  const aS100 = specialEvents
    .filter(se => se.player_id === playerAId && se.event_type === "S100" && sharedMatchIds.has(se.match_id))
    .reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
  
  const bS100 = specialEvents
    .filter(se => se.player_id === playerBId && se.event_type === "S100" && sharedMatchIds.has(se.match_id))
    .reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
  
  const aS1000 = specialEvents
    .filter(se => se.player_id === playerAId && se.event_type === "S1000" && sharedMatchIds.has(se.match_id))
    .reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
  
  const bS1000 = specialEvents
    .filter(se => se.player_id === playerBId && se.event_type === "S1000" && sharedMatchIds.has(se.match_id))
    .reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
  
  return {
    shared_matches_count: sharedMatches.length,
    matches: sharedMatches,
    player_a: { losses: aLosses, s100: aS100, s1000: aS1000 },
    player_b: { losses: bLosses, s100: bS100, s1000: bS1000 }
  };
}

/**
 * Tanggal (YYYY-MM-DD) sebuah game: dari waktu main, atau dari tanggal sesi bila waktu tidak ada.
 */
export function matchDay(match, sessions = []) {
  const d = String(match.played_at || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const s = sessions.find(x => x.session_id === match.session_id);
  const sd = s ? String(s.session_date || '').slice(0, 10) : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(sd) ? sd : '';
}

/**
 * Hari yang dinilai untuk MVP: hari ini bila sudah ada game, kalau belum hari terbaru yang punya game.
 */
export function pickMvpDate(days, today) {
  const list = Array.from(new Set((days || []).filter(Boolean))).sort();
  if (!list.length) return null;
  if (list.includes(today)) return today;
  const past = list.filter(d => d <= (today || ''));
  return past.length ? past[past.length - 1] : list[list.length - 1];
}

/**
 * MVP satu hari: Performance Index liga (persentil Ratus, Ribu, dan kalah) yang dihitung
 * hanya dari game pada hari itu. Pemain harus memainkan minimal `minGames` game hari itu
 * (atau, bila tak ada yang sebanyak itu, sebanyak game terbanyak yang dimainkan siapa pun).
 * Seri: kalah lebih sedikit, lalu Ratus+Ribu lebih banyak, lalu game lebih banyak, lalu nama.
 */
export function calculateDailyMVP(seasonId, date, players, matches, sessions, lossEvents, specialEvents, minGames = 3) {
  const dayMatches = matches.filter(m => m.season_id === seasonId && matchDay(m, sessions) === date);
  const result = { date, totalGames: dayMatches.length, threshold: 0, comparable: false, ranking: [], mvp: null };
  if (!dayMatches.length) return result;

  const stats = players.map(p => {
    const mine = dayMatches.filter(m => m.players.includes(p.player_id));
    const ids = new Set(mine.map(m => m.match_id));
    const sum = (list, pred, key) => list
      .filter(e => e.player_id === p.player_id && ids.has(e.match_id) && pred(e))
      .reduce((s, e) => s + (Number(e[key]) || 0), 0);
    const games = mine.length;
    const loss = sum(lossEvents, () => true, 'loss_count');
    const ratus = sum(specialEvents, e => e.event_type === 'S100', 'quantity');
    const ribu = sum(specialEvents, e => e.event_type === 'S1000', 'quantity');
    return {
      player_id: p.player_id, display_name: p.display_name, games, loss, ratus, ribu,
      ratus_rate: games ? (ratus / games) * 100 : 0,
      ribu_rate: games ? (ribu / games) * 100 : 0,
      loss_rate: games ? (loss / games) * 100 : 0,
      performance_index: 0
    };
  }).filter(s => s.games > 0);
  if (!stats.length) return result;

  const maxGames = Math.max(...stats.map(s => s.games));
  result.threshold = Math.min(minGames, maxGames);
  const qualified = stats.filter(s => s.games >= result.threshold);

  if (qualified.length >= 2) {
    const pR = calculatePercentiles(qualified.map(s => s.ratus_rate));
    const pB = calculatePercentiles(qualified.map(s => s.ribu_rate));
    const pL = calculatePercentiles(qualified.map(s => s.loss_rate));
    qualified.forEach((s, i) => {
      s.performance_index = Number(((pR[i] + pB[i] + (100 - pL[i])) / 3).toFixed(2));
    });
    result.comparable = true;
  } else if (qualified.length === 1) {
    qualified[0].performance_index = 50;
  }

  qualified.sort((a, b) =>
    b.performance_index - a.performance_index ||
    a.loss - b.loss ||
    (b.ratus + b.ribu) - (a.ratus + a.ribu) ||
    b.games - a.games ||
    a.display_name.localeCompare(b.display_name));
  result.ranking = qualified;
  result.mvp = qualified[0] || null;
  return result;
}
