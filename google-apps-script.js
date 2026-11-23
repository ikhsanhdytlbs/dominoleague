// Google Apps Script untuk DOMINO LEAGUE
// Cara pasang:
// 1. Buat Google Spreadsheet baru di Google Drive Anda.
// 2. Beri nama spreadsheet, misalnya: "DOMINO LEAGUE DATA".
// 3. Klik menu: Extensions (Ekstensi) > Apps Script.
// 4. Hapus semua kode default di Apps Script, lalu tempel (paste) seluruh kode di bawah ini.
// 5. Klik tombol "Deploy" (Terapkan) di kanan atas > "New deployment" (Penerapan baru).
// 6. Pilih jenis: "Web app" (Aplikasi Web).
// 7. Pada "Execute as", pilih: "Me" (Saya).
// 8. Pada "Who has access", pilih: "Anyone" (Siapa saja).
// 9. Klik "Deploy", izinkan akses akun Google Anda, lalu SALIN Web App URL yang didapat.
// 10. Buka Web App Domino League > Menu Pengaturan > Tempelkan Web App URL tersebut. Selesai!

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    status: "success",
    message: "Domino League Google Sheets Webhook is active and ready!",
    timestamp: new Date().toISOString()
  })).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.tryLock(10000);
  
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var payload = JSON.parse(e.postData.contents);
    var action = payload.action;
    var data = payload.data;
    
    initializeSheets(ss);
    
    if (action === "sync_all") {
      syncAllData(ss, data);
      return ContentService.createTextOutput(JSON.stringify({
        status: "success",
        message: "Full synchronization completed successfully."
      })).setMimeType(ContentService.MimeType.JSON);
    } else if (action === "add_match") {
      appendMatch(ss, data);
      return ContentService.createTextOutput(JSON.stringify({
        status: "success",
        message: "Match appended successfully."
      })).setMimeType(ContentService.MimeType.JSON);
    } else if (action === "ping") {
      return ContentService.createTextOutput(JSON.stringify({
        status: "success",
        message: "Connection verified successfully!"
      })).setMimeType(ContentService.MimeType.JSON);
    }
    
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      message: "Unknown action: " + action
    })).setMimeType(ContentService.MimeType.JSON);
    
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      message: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

function initializeSheets(ss) {
  var requiredSheets = [
    {
      name: "01_Dashboard_Leaderboard",
      headers: ["Rank", "Player ID", "Nama Pemain", "Total Main", "Total Sesi", "Total Ratus", "Total Ribu", "Total Kalah", "Ratus Rate", "Ribu Rate", "Loss Rate", "Performance Index", "Status Syarat"]
    },
    {
      name: "02_Data_Pemain",
      headers: ["Player ID", "Nama Tampilan", "Status Aktif", "Dibuat Pada"]
    },
    {
      name: "03_Data_Sesi",
      headers: ["Session ID", "Season ID", "Tanggal Sesi", "Label Sesi", "Status", "Catatan"]
    },
    {
      name: "04_Input_Pertandingan",
      headers: ["Match ID", "Session ID", "Match No", "Pemain 1", "Pemain 2", "Pemain 3", "Pemain 4", "Waktu Main", "Catatan"]
    },
    {
      name: "05_Detail_Kekalahan",
      headers: ["Loss ID", "Match ID", "Session ID", "Player ID", "Nama Pemain", "Jumlah Kalah"]
    },
    {
      name: "06_Detail_Kejadian",
      headers: ["Event ID", "Match ID", "Session ID", "Player ID", "Nama Pemain", "Jenis Kejadian", "Jumlah"]
    },
    {
      name: "09_Penghargaan_Season",
      headers: ["Kategori Penghargaan", "Pemenang", "Metrik Nilai", "Keterangan", "Season"]
    }
  ];
  
  for (var i = 0; i < requiredSheets.length; i++) {
    var item = requiredSheets[i];
    var sheet = ss.getSheetByName(item.name);
    if (!sheet) {
      sheet = ss.insertSheet(item.name);
      sheet.appendRow(item.headers);
      var headerRange = sheet.getRange(1, 1, 1, item.headers.length);
      headerRange.setFontWeight("bold");
      headerRange.setBackground("#1E293B");
      headerRange.setFontColor("#FFFFFF");
      sheet.setFrozenRows(1);
    }
  }
}

function syncAllData(ss, data) {
  // 1. Data Pemain
  if (data.players) {
    var pSheet = ss.getSheetByName("02_Data_Pemain");
    clearSheetData(pSheet);
    var pRows = [];
    for (var i = 0; i < data.players.length; i++) {
      var p = data.players[i];
      pRows.push([p.player_id, p.display_name, p.is_active ? "AKTIF" : "NONAKTIF", p.created_at || ""]);
    }
    if (pRows.length > 0) {
      pSheet.getRange(2, 1, pRows.length, pRows[0].length).setValues(pRows);
    }
  }
  
  // 2. Data Sesi
  if (data.sessions) {
    var sSheet = ss.getSheetByName("03_Data_Sesi");
    clearSheetData(sSheet);
    var sRows = [];
    for (var j = 0; j < data.sessions.length; j++) {
      var s = data.sessions[j];
      sRows.push([s.session_id, s.season_id, s.session_date, s.session_label || "", s.status || "active", s.notes || ""]);
    }
    if (sRows.length > 0) {
      sSheet.getRange(2, 1, sRows.length, sRows[0].length).setValues(sRows);
    }
  }
  
  // 3. Pertandingan
  if (data.matches) {
    var mSheet = ss.getSheetByName("04_Input_Pertandingan");
    clearSheetData(mSheet);
    var mRows = [];
    for (var k = 0; k < data.matches.length; k++) {
      var m = data.matches[k];
      mRows.push([
        m.match_id,
        m.session_id,
        m.match_number || (k + 1),
        m.players[0] || "",
        m.players[1] || "",
        m.players[2] || "",
        m.players[3] || "",
        m.played_at || "",
        m.notes || ""
      ]);
    }
    if (mRows.length > 0) {
      mSheet.getRange(2, 1, mRows.length, mRows[0].length).setValues(mRows);
    }
  }
  
  // 4. Detail Kekalahan
  if (data.loss_events) {
    var lSheet = ss.getSheetByName("05_Detail_Kekalahan");
    clearSheetData(lSheet);
    var lRows = [];
    for (var l = 0; l < data.loss_events.length; l++) {
      var le = data.loss_events[l];
      lRows.push([le.loss_id, le.match_id, le.session_id || "", le.player_id, le.player_name || "", le.loss_count]);
    }
    if (lRows.length > 0) {
      lSheet.getRange(2, 1, lRows.length, lRows[0].length).setValues(lRows);
    }
  }
  
  // 5. Detail Kejadian
  if (data.special_events) {
    var eSheet = ss.getSheetByName("06_Detail_Kejadian");
    clearSheetData(eSheet);
    var eRows = [];
    for (var n = 0; n < data.special_events.length; n++) {
      var se = data.special_events[n];
      eRows.push([se.event_id, se.match_id, se.session_id || "", se.player_id, se.player_name || "", eventLabel(se.event_type), se.quantity]);
    }
    if (eRows.length > 0) {
      eSheet.getRange(2, 1, eRows.length, eRows[0].length).setValues(eRows);
    }
  }
  
  // 6. Leaderboard / Dashboard
  if (data.leaderboard) {
    var lbSheet = ss.getSheetByName("01_Dashboard_Leaderboard");
    clearSheetData(lbSheet);
    var lbRows = [];
    for (var r = 0; r < data.leaderboard.length; r++) {
      var row = data.leaderboard[r];
      lbRows.push([
        r + 1,
        row.player_id,
        row.display_name,
        row.total_matches,
        row.total_sessions,
        row.total_s100,
        row.total_s1000,
        row.total_loss,
        row.s100_rate,
        row.s1000_rate,
        row.loss_rate,
        row.performance_index,
        row.eligible ? "MEMENUHI" : "DI BAWAH AMBANG"
      ]);
    }
    if (lbRows.length > 0) {
      lbSheet.getRange(2, 1, lbRows.length, lbRows[0].length).setValues(lbRows);
    }
  }
  
  // 7. Awards
  if (data.awards) {
    var awSheet = ss.getSheetByName("09_Penghargaan_Season");
    clearSheetData(awSheet);
    var awRows = [];
    for (var a = 0; a < data.awards.length; a++) {
      var aw = data.awards[a];
      awRows.push([aw.title, aw.winner_name, aw.value, aw.criteria, data.season_name || "Season Aktif"]);
    }
    if (awRows.length > 0) {
      awSheet.getRange(2, 1, awRows.length, awRows[0].length).setValues(awRows);
    }
  }
}

function eventLabel(type) {
  return type === "S1000" ? "Ribu" : (type === "S100" ? "Ratus" : type);
}

function clearSheetData(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
  }
}

function appendMatch(ss, data) {
  // Appends 1 match, its loss events, and special events
  var mSheet = ss.getSheetByName("04_Input_Pertandingan");
  mSheet.appendRow([
    data.match.match_id,
    data.match.session_id,
    data.match.match_number,
    data.match.players[0] || "",
    data.match.players[1] || "",
    data.match.players[2] || "",
    data.match.players[3] || "",
    data.match.played_at,
    data.match.notes || ""
  ]);
  
  if (data.loss_events && data.loss_events.length > 0) {
    var lSheet = ss.getSheetByName("05_Detail_Kekalahan");
    for (var i = 0; i < data.loss_events.length; i++) {
      var le = data.loss_events[i];
      lSheet.appendRow([le.loss_id, le.match_id, le.session_id, le.player_id, le.player_name, le.loss_count]);
    }
  }
  
  if (data.special_events && data.special_events.length > 0) {
    var eSheet = ss.getSheetByName("06_Detail_Kejadian");
    for (var j = 0; j < data.special_events.length; j++) {
      var se = data.special_events[j];
      eSheet.appendRow([se.event_id, se.match_id, se.session_id, se.player_id, se.player_name, eventLabel(se.event_type), se.quantity]);
    }
  }
}
