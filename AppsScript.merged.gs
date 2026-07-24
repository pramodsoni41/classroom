/* ============================================================
   CLASSROOM + QUIZ + ATTENDANCE — UNIFIED BACKEND
   Bind this script to ONE spreadsheet that holds ALL tabs:
     Students, LoginLogs, Messages,
     Marks, Attendance, Notes, Announcements,
     QuizConfig, Q_<QuizId>, Resp_<QuizId>,
     AttendanceLogs, Config
   Everything uses getActiveSpreadsheet() — no external sheet IDs.
   ============================================================ */

/* =========================
   CONFIG
========================= */

const STUDENT_TAB = "Students";

const SHEET_MARKS         = "Marks";
const SHEET_ATTENDANCE    = "Attendance";
const SHEET_NOTES         = "Notes";
const SHEET_ANNOUNCEMENTS = "Announcements";
const SHEET_LOGIN_LOGS    = "LoginLogs";

const QUIZ_SESSION_PREFIX  = "quizsess_";
const QUIZ_SESSION_TTL_SEC = 6 * 60 * 60;

/* Attendance QR config — these are FALLBACK defaults.
   The live values come from the Config sheet keys "qr_validity_sec" and
   "qr_grace_sec" (see attQrValiditySec_ / attQrGraceSec_). Edit the sheet,
   not this file, to change the QR lifetime. */
const ATT_QR_VALIDITY_SEC   = 40;
const ATT_QR_GRACE_SEC      = 10;
const ATT_QR_CACHE_TTL_SEC  = 120;
const ATT_STUDENT_CACHE_TTL = 300;
const ATT_CONFIG_CACHE_TTL  = 300;
const ATT_DUPLICATE_WIN_SEC = 1200;

/* =========================
   ROUTER — GET (classroom)
========================= */

function doGet(e) {
  const action = String(e.parameter.action || "").trim();
  const callback = e.parameter.callback || null;

  if (action === "dashboard")      return dashboard(e);
  if (action === "changePassword") return changePassword(e);
  if (action === "googleLogin")    return googleLogin(e);

  if (action === "submitMessage") {
    return jsonOutput(submitMessage(e), callback);
  }

  /* Quiz — GET/JSONP (POST redirect strips the body, so quiz reads from URL params) */
  if (action === "getQuizMeta")  return jsonOutput(quizMeta_({ quizId: e.parameter.quizId }), callback);
  if (action === "startQuiz")    return jsonOutput(quizStart_({
    sessionToken:  e.parameter.sessionToken  || "",
    roll:          e.parameter.roll          || "",
    password:      e.parameter.password      || "",
    classPassword: e.parameter.classPassword || "",
    quizId:        e.parameter.quizId        || ""
  }), callback);
  if (action === "getQuestions") return jsonOutput(quizGetQuestions_({ sessionToken: e.parameter.sessionToken || "" }), callback);

  /* Attendance — JSONP GET */
  const type = String(e.parameter.type || "").trim().toLowerCase();
  /* NOTE: there is deliberately no "get_admin_pass" route. The admin password is
     never sent to a client — attGenerateQR_ verifies it server-side instead. */
  if (type === "get_sessions")    return jsonOutput({ status: "success", sessions: attGetSessions_() }, callback);
  if (type === "generate_qr")     return jsonOutput(attGenerateQR_(e.parameter), callback);
  if (type === "mark_attendance")  return jsonOutput(attMarkAttendance_(e.parameter), callback);

  return jsonOutput({ status: "error", message: "Invalid action" }, callback);
}

/* =========================
   ROUTER — POST (quiz)
   The quiz frontend POSTs JSON (text/plain) here.
========================= */

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(8000)) return jsonOutput({ status: "busy", message: "Server busy, retry" });

    let data = {};
    try {
      data = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    } catch (_) {
      return jsonOutput({ status: "error", message: "Bad request body" });
    }

    const action = String(data.action || "").trim();

    if (action === "getQuizMeta")  return jsonOutput(quizMeta_(data));
    if (action === "startQuiz")    return jsonOutput(quizStart_(data));
    if (action === "getQuestions") return jsonOutput(quizGetQuestions_(data));
    if (action === "submitQuiz")   return jsonOutput(quizSubmit_(data));

    return jsonOutput({ status: "error", message: "Invalid action" });

  } catch (err) {
    return jsonOutput({ status: "error", message: String(err && err.message ? err.message : err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

/* ============================================================
   QUIZ HANDLERS
   ============================================================ */

/* Public meta — no auth (does NOT return the class password) */
function quizMeta_(data) {
  const quizId = String(data.quizId || "").trim();
  const row = getQuizConfigRow_(quizId);
  if (!row) return { status: "error", message: "Quiz not found" };
  return { status: "ok", meta: buildQuizMeta_(row) };
}

/* Verify classroom session + class password, then issue a quiz session */
function quizStart_(data) {
  const auth = verifyClassroomAuth_(data);
  if (!auth) return { status: "unauthorized" };

  const quizId = String(data.quizId || "").trim();
  const row = getQuizConfigRow_(quizId);
  if (!row) return { status: "error", message: "Quiz not found" };

  const state = quizStartState_(row);
  if (state !== "ok") return { status: state }; // upcoming | expired | closed

  const meta = buildQuizMeta_(row);

  // Class password verified SERVER-SIDE (never sent to client)
  const required = String(row.ClassPassword || "").trim();
  if (required) {
    const entered = String(data.classPassword || "").trim();
    if (entered !== required) return { status: "badpass" };
  }

  // One attempt unless allowed
  if (!meta.allowMultipleAttempts && hasAttempted_(quizId, auth.roll)) {
    return { status: "used" };
  }

  const name  = String(auth.student.Name  || "").trim();
  const phone = String(auth.student.Phone || "NA").trim();

  const token = Utilities.getUuid();
  CacheService.getScriptCache().put(
    QUIZ_SESSION_PREFIX + token,
    JSON.stringify({ roll: auth.roll, name: name, phone: phone, quizId: quizId }),
    QUIZ_SESSION_TTL_SEC
  );

  return { status: "ok", sessionToken: token, name: name, phone: phone, meta: meta };
}

/* Return questions for the quiz bound to a valid quiz session */
function quizGetQuestions_(data) {
  const sess = getQuizSession_(data.sessionToken);
  if (!sess) return { status: "unauthorized" };

  const row = getQuizConfigRow_(sess.quizId);
  if (!row) return { status: "error", message: "Quiz not found" };

  if (quizStartState_(row) === "expired") return { status: "expired" };

  const sheet = getQuizQuestionsSheet_(sess.quizId);
  if (!sheet) return { status: "error", message: "Questions sheet missing" };

  return { status: "ok", meta: buildQuizMeta_(row), questions: getQuizQuestions_(sheet) };
}

/* Score + store submission */
function quizSubmit_(data) {
  const sess = getQuizSession_(data.sessionToken);
  if (!sess) return { status: "unauthorized" };

  const row = getQuizConfigRow_(sess.quizId);
  if (!row) return { status: "error", message: "Quiz not found" };

  const meta  = buildQuizMeta_(row);
  const sheet = getQuizQuestionsSheet_(sess.quizId);
  if (!sheet) return { status: "error", message: "Questions sheet missing" };

  const qRows = getQuizQuestionRows_(sheet);
  const letters = ["A", "B", "C", "D"];

  const respMap = {};
  (data.responses || []).forEach(r => { if (r && r.questionId) respMap[String(r.questionId)] = r; });

  const stats = { correct: 0, incorrect: 0, skipped: 0, score: 0 };

  const review = qRows.map((rw, i) => {
    const qId = "Q" + (i + 1);
    const resp = respMap[qId];
    const sel = (resp && resp.selectedIndex !== undefined) ? Number(resp.selectedIndex) : -1;
    const att = sel >= 0 && sel <= 3;
    const userLetter = att ? letters[sel] : null;
    const correctLetter = String(rw[5] || "").trim().toUpperCase();
    const isCorrect = att ? (userLetter === correctLetter) : null;

    if (!att) { stats.skipped++; }
    else if (isCorrect) { stats.correct++; stats.score += meta.correctMarks; }
    else { stats.incorrect++; stats.score += meta.incorrectMarks; }

    return {
      question: rw[0],
      yourAnswer: att ? rw[sel + 1] : "No answer",
      correctAnswer: meta.showAnswers ? rw[letters.indexOf(correctLetter) + 1] : "Hidden",
      isCorrect: isCorrect
    };
  });

  const maxMarks = qRows.length * meta.correctMarks;
  const percentage = maxMarks > 0 ? (stats.score / maxMarks) * 100 : 0;

  const respSheet = getOrCreateResponsesSheet_(sess.quizId);
  respSheet.appendRow([
    new Date(), sess.name, sess.roll, sess.phone || "",
    stats.score, qRows.length, maxMarks, percentage.toFixed(2),
    JSON.stringify(data.responses || []), JSON.stringify(review)
  ]);

  return {
    status: "submitted",
    result: {
      score: Number(stats.score).toFixed(2),
      maxMarks: Number(maxMarks).toFixed(2),
      totalQuestions: qRows.length,
      correctCount: stats.correct,
      incorrectCount: stats.incorrect,
      skippedCount: stats.skipped,
      percentage: percentage.toFixed(2),
      review: review
    }
  };
}

/* ============================================================
   QUIZ HELPERS
   ============================================================ */

/* Trust the classroom login: Google session token OR roll+password */
function verifyClassroomAuth_(data) {
  const sessionToken = String(data.sessionToken || "").trim();
  const roll = String(data.roll || "").trim();
  const password = String(data.password || "").trim();

  let verifiedRoll = null;

  if (sessionToken) {
    const cached = CacheService.getScriptCache().get("gsession_" + sessionToken);
    if (cached) verifiedRoll = String(cached).trim();
  }

  if (!verifiedRoll && roll && password) {
    const students = getStudentsData_();
    const m = students.find(r =>
      String(r.RollNo || "").trim() === roll &&
      String(r.Password || "").trim() === password
    );
    if (m) verifiedRoll = roll;
  }

  if (!verifiedRoll) return null;

  const students = getStudentsData_();
  const student = students.find(r => String(r.RollNo || "").trim() === verifiedRoll);
  if (!student) return null;

  return { roll: verifiedRoll, student: student };
}

function getQuizConfigRow_(quizId) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("QuizConfig");
  if (!sheet) return null;
  const items = convertToObjects_(sheet.getDataRange().getValues());
  return items.find(q => String(q.QuizId || "").trim() === String(quizId).trim()) || null;
}

function computeQuizStatus_(row) {
  let status = String(row.Status || "CLOSED").trim().toUpperCase();
  const now = new Date();
  const openDate  = row.OpenDate  ? new Date(row.OpenDate)  : null;
  const closeDate = row.CloseDate ? new Date(row.CloseDate) : null;
  if (status === "OPEN") {
    if (closeDate && now > closeDate) status = "EXPIRED";
    if (openDate  && now < openDate)  status = "UPCOMING";
  }
  return status;
}

function quizStartState_(row) {
  const status = computeQuizStatus_(row);
  if (status === "UPCOMING") return "upcoming";
  if (status === "EXPIRED")  return "expired";
  if (status !== "OPEN")     return "closed";
  return "ok";
}

function buildQuizMeta_(row) {
  return {
    quizId:       String(row.QuizId   || "").trim(),
    quizName:     String(row.QuizName || "Quiz").trim(),
    status:       computeQuizStatus_(row),
    dueDate:      row.CloseDate || "",
    instructions: String(row.Instructions || "").trim(),
    correctMarks:   Number(row.CorrectMarks) || 4,
    incorrectMarks: (row.NegativeMarks === "" || row.NegativeMarks == null) ? -1 : Number(row.NegativeMarks),
    showAnswers:           isYesC_(row.ShowAnswers),
    showSummary:           (row.ShowSummary === undefined || row.ShowSummary === "") ? true : isYesC_(row.ShowSummary),
    showInstantFeedback:   isYesC_(row.ShowInstantFeedback),
    allowMultipleAttempts: isYesC_(row.AllowMultiple),
    shuffleQuestions:      isYesC_(row.ShuffleQuestions),
    shuffleOptions:        isYesC_(row.ShuffleOptions),
    needsClassPassword:    String(row.ClassPassword || "").trim() !== ""
  };
}

function getQuizQuestionsSheet_(quizId) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Q_" + quizId);
}

function getQuizQuestionRows_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, 7).getValues()
    .filter(r => String(r[0] || "").trim() !== "");
}

function getQuizQuestions_(sheet) {
  return getQuizQuestionRows_(sheet).map((row, i) => ({
    questionId: "Q" + (i + 1),
    question:   row[0],
    options:    { A: row[1], B: row[2], C: row[3], D: row[4] },
    time:       toNumberC_(row[6], 15)
  }));
}

function getOrCreateResponsesSheet_(quizId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName("Resp_" + quizId);
  if (!sh) {
    sh = ss.insertSheet("Resp_" + quizId);
    sh.appendRow(["Timestamp", "Name", "RollNo", "Phone", "Score", "Questions", "MaxMarks", "Percentage", "ResponsesJSON", "ReviewJSON"]);
  }
  return sh;
}

function hasAttempted_(quizId, roll) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Resp_" + quizId);
  if (!sh) return false;
  const items = convertToObjects_(sh.getDataRange().getValues());
  return items.some(r => String(r.RollNo || "").trim() === String(roll).trim());
}

function getQuizSession_(token) {
  const raw = CacheService.getScriptCache().get(QUIZ_SESSION_PREFIX + String(token || ""));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function isYesC_(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  return s === "yes" || s === "true" || s === "1" || s === "y";
}

function toNumberC_(v, fb) { const n = Number(v); return isNaN(n) ? fb : n; }

/* ============================================================
   GOOGLE LOGIN  (unchanged)
   ============================================================ */

function googleLogin(e) {
  const token = String(e.parameter.token || "").trim();
  if (!token) return jsonOutput({ status: "error", message: "Token missing" });

  let email;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Invalid token');

    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';

    const payload = JSON.parse(
      Utilities.base64Decode(b64).map(b => String.fromCharCode(b)).join('')
    );

    const validIssuers = ['accounts.google.com', 'https://accounts.google.com'];
    if (!validIssuers.includes(payload.iss)) {
      return jsonOutput({ status: "error", message: "Invalid token issuer" });
    }
    if (payload.aud !== '589647151742-imup6ivhj023l40d9flhggpgg04juqbu.apps.googleusercontent.com') {
      return jsonOutput({ status: "error", message: "Invalid token audience" });
    }
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return jsonOutput({ status: "error", message: "Token expired" });
    }

    email = String(payload.email || "").trim().toLowerCase();
  } catch (err) {
    return jsonOutput({ status: "error", message: "Token decode failed: " + err.message });
  }

  if (!email) return jsonOutput({ status: "error", message: "Could not read email" });

  const students = getStudentsData_();
  const student = students.find(row =>
    String(row.GoogleEmail || "").trim().toLowerCase() === email
  );

  if (!student) {
    return jsonOutput({
      status: "error",
      message: "This Google account is not registered. Contact your instructor."
    });
  }

  const courses = getCourses_(student);
  if (courses.length === 0) {
    return jsonOutput({ status: "error", message: "No course assigned" });
  }

  const sessionToken = Utilities.getUuid();
  CacheService.getScriptCache().put("gsession_" + sessionToken, student.RollNo, 4 * 60 * 60);

  logStudentLogin_(student.RollNo, student.Name, "SUCCESS-GOOGLE", "", "", "", "", "", "", "", "Google Login");

  return jsonOutput({
    status: "success",
    sessionToken: sessionToken,
    student: {
      RollNo: student.RollNo,
      Name:   student.Name,
      Phone:  student.Phone || "NA",
      Email:  student.Email || "",
      Password: student.Password || "",
      Courses: courses
    }
  });
}

/* =========================
   LOGIN LOGS
========================= */

function logStudentLogin_(roll, name, status, browser, device, deviceId, ip, latitude, longitude, accuracy, remarks) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_LOGIN_LOGS);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_LOGIN_LOGS);
    sheet.appendRow(["Timestamp","RollNo","Name","Login Status","Browser","Device","Device ID","IP Address","Latitude","Longitude","Accuracy","Remarks"]);
  }

  sheet.appendRow([new Date(), roll||"", name||"", status||"", browser||"", device||"", deviceId||"", ip||"", latitude||"", longitude||"", accuracy||"", remarks||""]);
}

/* =========================
   DASHBOARD
========================= */

function submitMessage(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Messages");

  if (!sheet) return { status: "error", message: "Messages sheet not found" };

  sheet.appendRow([new Date(), e.parameter.roll||"", e.parameter.name||"", e.parameter.message||""]);
  return { status: "success" };
}

function dashboard(e) {
  const roll         = String(e.parameter.roll         || "").trim();
  const password     = String(e.parameter.password     || "").trim();
  const sessionToken = String(e.parameter.sessionToken || "").trim();

  if (!roll) {
    return jsonOutput({ status: "error", message: "Unauthorized access" });
  }

  let verified = false;
  let studentRollNo = null;

  if (sessionToken) {
    const cached = CacheService.getScriptCache().get("gsession_" + sessionToken);
    if (cached === roll) { verified = true; studentRollNo = roll; }
  } else if (password) {
    const students = getStudentsData_();
    const match = students.find(row =>
      String(row.RollNo   || "").trim() === roll &&
      String(row.Password || "").trim() === password
    );
    if (match) { verified = true; studentRollNo = roll; }
  }

  if (!verified) {
    return jsonOutput({ status: "error", message: "Invalid credentials" });
  }

  const students = getStudentsData_();
  const student = students.find(row => String(row.RollNo || "").trim() === studentRollNo);
  if (!student) return jsonOutput({ status: "error", message: "Student not found" });

  const courses = getCourses_(student);
  if (courses.length === 0) {
    return jsonOutput({ status: "error", message: "No course assigned" });
  }

  const marks       = getSheetData_(SHEET_MARKS);
  const attendance  = getSheetData_(SHEET_ATTENDANCE);
  const notes       = getSheetData_(SHEET_NOTES);
  const announcements = getSheetData_(SHEET_ANNOUNCEMENTS);

  const studentMarks = marks.filter(r =>
    String(r.RollNo || "").trim() === roll &&
    courses.includes(String(r.Course || "").trim())
  );

  const studentAttendance = attendance.filter(r =>
    String(r.RollNo || "").trim() === roll &&
    courses.includes(String(r.Course || "").trim())
  );

  const filteredNotes = notes.filter(r =>
    courses.includes(String(r.Course || "").trim()) &&
    String(r.Live || "").trim().toLowerCase() === "yes"
  );

  const filteredAnnouncements = announcements.filter(r =>
    courses.includes(String(r.Course || "").trim()) &&
    String(r.Live || "").trim().toLowerCase() === "yes"
  );

  const quizConfigSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("QuizConfig");
  const quizzes = quizConfigSheet ? getQuizList_(courses, quizConfigSheet) : [];

  return jsonOutput({
    status: "success",
    student: {
      RollNo: student.RollNo,
      Name:   student.Name,
      Phone:  student.Phone || "NA",
      Courses: courses
    },
    marks:       studentMarks,
    attendance:  studentAttendance,
    notes:       filteredNotes,
    quizzes:     quizzes,
    announcements: filteredAnnouncements.sort((a, b) =>
      new Date(b.Date || 0) - new Date(a.Date || 0)
    )
  });
}

/* =========================
   QUIZ CONFIG → DASHBOARD LIST
========================= */

function getQuizList_(courses, sheet) {
  const items = convertToObjects_(sheet.getDataRange().getValues());

  return items
    .filter(q => {
      const qCourse = String(q.Course || "").trim().toUpperCase();
      return qCourse === "" || qCourse === "ALL" || courses.map(c => c.toUpperCase()).includes(qCourse);
    })
    .map(q => {
      const status = computeQuizStatus_(q);
      const openDate  = q.OpenDate  ? new Date(q.OpenDate)  : null;
      const closeDate = q.CloseDate ? new Date(q.CloseDate) : null;

      return {
        QuizId:        String(q.QuizId   || "").trim(),
        QuizName:      String(q.QuizName || "").trim(),
        Course:        String(q.Course   || "").trim(),
        URL:           String(q.URL      || "").trim(),
        Status:        status,
        OpenDate:      openDate  ? openDate.toLocaleDateString("en-IN")  : "",
        CloseDate:     closeDate ? closeDate.toLocaleDateString("en-IN") : "",
        CorrectMarks:  Number(q.CorrectMarks)  || 4,
        NegativeMarks: (q.NegativeMarks === "" || q.NegativeMarks == null) ? -1 : Number(q.NegativeMarks),
        ClassPassword: String(q.ClassPassword || "").trim()
      };
    });
}

/* =========================
   CHANGE PASSWORD
========================= */

function changePassword(e) {
  const roll    = String(e.parameter.roll        || "").trim();
  const oldPass = String(e.parameter.oldPassword || "").trim();
  const newPass = String(e.parameter.newPassword || "").trim();

  if (!roll || !oldPass || !newPass) {
    return jsonOutput({ status: "error", message: "All fields required" });
  }

  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(STUDENT_TAB);
  const data  = sheet.getDataRange().getValues();
  const headers = data[0];

  const rollIndex = headers.indexOf("RollNo");
  const passIndex = headers.indexOf("Password");

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][rollIndex]).trim() === roll) {
      if (String(data[i][passIndex]).trim() !== oldPass) {
        return jsonOutput({ status: "error", message: "Wrong old password" });
      }
      sheet.getRange(i + 1, passIndex + 1).setValue(newPass);
      SpreadsheetApp.flush();
      return jsonOutput({ status: "success", message: "Password updated" });
    }
  }

  return jsonOutput({ status: "error", message: "Student not found" });
}

/* =========================
   SHARED HELPERS
========================= */

function getStudentsData_() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(STUDENT_TAB);
  return convertToObjects_(sheet.getDataRange().getValues());
}

function getSheetData_(sheetName) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return [];
  return convertToObjects_(sheet.getDataRange().getValues());
}

function convertToObjects_(values) {
  const headers = values[0];
  return values.slice(1).map(row => {
    let obj = {};
    headers.forEach((h, i) => obj[String(h).trim()] = row[i]);
    return obj;
  });
}

function getCourses_(student) {
  const multi  = String(student.Courses || "").trim();
  const single = String(student.Course  || "").trim();
  if (multi)  return multi.split(",").map(c => c.trim()).filter(Boolean);
  if (single) return [single];
  return [];
}

function jsonOutput(obj, callback) {
  const json = JSON.stringify(obj);
  if (callback) {
    return ContentService
      .createTextOutput(`${callback}(${json})`)
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

/* ============================================================
   ATTENDANCE — QR GENERATION & MARKING
   AttendanceLogs tab columns:
     A=DateTime  B=StudentID  C=SessionID  D=Token
     E=Timestamp F=ScanLatency G=DeviceID  H=Name
     I=Latitude  J=Longitude
   ============================================================ */

function attGenerateQR_(params) {
  /* Admin password is verified HERE, server-side. It is never sent to a client. */
  const required = String(attGetConfig_("admin_pass") || "").trim();
  const supplied = String(params.admin_pass || "").trim();
  if (!required || supplied !== required) return { status: "bad_admin_pass" };

  const session_id   = String(params.session_id || "1").trim();
  const secret       = attGetConfig_("secret_key");
  const timestampSec = Math.floor(Date.now() / 1000);
  const token        = Math.random().toString(36).substring(2, 10);
  const fullSig      = attSignature_(session_id, timestampSec, token, secret);
  const shortSig     = fullSig.substring(0, 16);
  const qrString     = [session_id, timestampSec, token, shortSig].join("|");

  CacheService.getScriptCache().put(
    "qr_token_" + token,
    JSON.stringify({ session_id, timestamp: timestampSec, signature: shortSig }),
    ATT_QR_CACHE_TTL_SEC
  );

  return {
    status:       "success",
    qr_payload:   qrString,
    server_time:  Date.now(),
    validity_sec: attQrValiditySec_(),
    grace_sec:    attQrGraceSec_()
  };
}

function attMarkAttendance_(data) {
  try {
    const student_id = String(data.student_id    || "").trim();
    const session_id = String(data.session_id    || "").trim();
    const token      = String(data.token         || "").trim();
    const signature  = String(data.signature     || "").trim();
    const device_id  = String(data.device_id     || "").trim();
    const lat        = String(data.lat           || "").trim();
    const lon        = String(data.lon           || "").trim();
    const t_gen      = Number(data.timestamp     || 0);
    const t_now      = Math.floor(Date.now() / 1000);
    const qrAge      = t_now - t_gen;

    if (!session_id || !token || !t_gen || !signature || !device_id)
      return { status: "error", message: "Incomplete parameters" };

    if (qrAge < 0)                                  return { status: "invalid_time" };
    if (qrAge > (attQrValiditySec_() + attQrGraceSec_())) return { status: "qr_stale" };
    if (qrAge > 600)                                return { status: "expired" };

    const secret      = attGetConfig_("secret_key");
    const expectedSig = attSignature_(session_id, t_gen, token, secret).substring(0, 16);
    if (signature !== expectedSig) return { status: "invalid_sig" };

    if (!CacheService.getScriptCache().get("qr_token_" + token))
      return { status: "qr_invalid" };

    /* --- Student lookup --- */
    const ss            = SpreadsheetApp.getActiveSpreadsheet();
    const studentsSheet = ss.getSheetByName(STUDENT_TAB);
    if (!studentsSheet) return { status: "error", message: "Students sheet missing" };

    const norm = (val) => {
      if (typeof val === "number") val = val.toFixed(0);
      return String(val || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
    };

    const normDevice = norm(device_id);
    const normRoll   = norm(student_id);
    const bundle     = attGetStudentsBundle_(studentsSheet);

    let finalRoll = "", studentName = "", matchedRow = -1;
    let foundMatch = false, needsReg = false, deviceChanged = false;

    if (normDevice && bundle.deviceMap[normDevice]) {
      const rec    = bundle.deviceMap[normDevice];
      finalRoll    = rec.roll;
      studentName  = rec.name;
      matchedRow   = rec.row;
      foundMatch   = true;
    } else if (normRoll && bundle.rollMap[normRoll]) {
      const rec    = bundle.rollMap[normRoll];
      finalRoll    = rec.roll;
      studentName  = rec.name;
      matchedRow   = rec.row;
      deviceChanged = !!(rec.device && rec.device !== normDevice);
      needsReg     = !rec.device;
      foundMatch   = true;

      if (deviceChanged) {
        attFlagDeviceChange_(studentsSheet, matchedRow, device_id, bundle);
      }
    }

    if (!foundMatch) return { status: "register_required" };

    /* --- First-time device registration (only if DeviceID column exists) --- */
    const devColIdx = bundle.devColIdx || 0;
    if (needsReg && devColIdx > 0) {
      const lk = LockService.getScriptLock();
      try {
        if (!lk.tryLock(2000)) return { status: "busy" };
        const existing = norm(studentsSheet.getRange(matchedRow, devColIdx).getValue());
        if (!existing) {
          studentsSheet.getRange(matchedRow, devColIdx).setValue(device_id);
          attInvalidateStudentsCache_();
        } else if (existing !== normDevice) {
          attFlagDeviceChange_(studentsSheet, matchedRow, device_id, bundle, false);
          return { status: "device_already_registered" };
        }
      } finally { try { lk.releaseLock(); } catch(_) {} }
    }

    /* --- Duplicate check --- */
    const logSheet = attGetOrCreateLog_(ss);
    const cache    = CacheService.getScriptCache();
    const dupKey   = "att_" + session_id + "_" + finalRoll;
    let isDuplicate = false;

    if (logSheet.getLastRow() > 1 && cache.get(dupKey)) {
      isDuplicate = true;
    } else {
      cache.put(dupKey, "1", ATT_DUPLICATE_WIN_SEC);
    }

    /* --- Write record --- */
    const row = [new Date(), finalRoll, session_id, token, t_gen, qrAge + "s", device_id, studentName, lat, lon];
    const wl  = LockService.getScriptLock();
    if (!wl.tryLock(2000)) return { status: "busy" };
    try {
      logSheet.getRange(logSheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
    } finally { try { wl.releaseLock(); } catch(_) {} }

    return { status: "success", roll: finalRoll, name: studentName, duplicate: isDuplicate, device_changed: deviceChanged };

  } catch (err) {
    return { status: "error", message: err && err.message ? err.message : String(err) };
  }
}

/* Flag a device change WITHOUT corrupting Phone/Name/Course.
   Writes only to columns located by header name:
     - DeviceStatus      (optional) → "⚠️ Device Changed"
     - DeviceChangeCount (optional) → incremented
     - DeviceID          → updated to the new device when updateDevice !== false
   If the optional columns don't exist, they're simply skipped. */
function attFlagDeviceChange_(sheet, row, device_id, bundle, updateDevice) {
  const lk = LockService.getScriptLock();
  try {
    if (!lk.tryLock(2000)) return;
    if (bundle.statusColIdx > 0) sheet.getRange(row, bundle.statusColIdx).setValue("⚠️ Device Changed");
    if (bundle.countColIdx > 0) {
      const prev = Number(sheet.getRange(row, bundle.countColIdx).getValue() || 0);
      sheet.getRange(row, bundle.countColIdx).setValue(prev + 1);
    }
    if (updateDevice !== false && bundle.devColIdx > 0) {
      sheet.getRange(row, bundle.devColIdx).setValue(device_id);
      attInvalidateStudentsCache_();
    }
  } finally { try { lk.releaseLock(); } catch(_) {} }
}

function attGetOrCreateLog_(ss) {
  let sh = ss.getSheetByName("AttendanceLogs");
  if (!sh) {
    sh = ss.insertSheet("AttendanceLogs");
    sh.appendRow(["DateTime","StudentID","SessionID","Token","Timestamp","ScanLatency","DeviceID","Name","Latitude","Longitude"]);
  }
  return sh;
}

function attGetStudentsBundle_(sheet) {
  const cache    = CacheService.getScriptCache();
  const cacheKey = "att_students_v1";
  const cached   = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const all = sheet.getDataRange().getValues();
  if (all.length < 2) return { rollMap: {}, deviceMap: {} };

  const headers  = all[0].map(h => String(h).trim());
  const rollIdx  = headers.indexOf("RollNo");
  const nameIdx  = headers.indexOf("Name");
  const devIdx   = headers.indexOf("DeviceID");
  // Optional anti-cheat tracking columns — only written to if they exist.
  const statusIdx = headers.indexOf("DeviceStatus");
  const countIdx  = headers.indexOf("DeviceChangeCount");
  const devColIdx    = devIdx    >= 0 ? devIdx    + 1 : 0;  // 1-based for getRange, 0 = not found
  const statusColIdx = statusIdx >= 0 ? statusIdx + 1 : 0;
  const countColIdx  = countIdx  >= 0 ? countIdx  + 1 : 0;

  const deviceMap = {}, rollMap = {};
  const norm = (val) => {
    if (typeof val === "number") val = val.toFixed(0);
    return String(val || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  };

  for (let i = 1; i < all.length; i++) {
    const r      = all[i];
    const roll   = rollIdx  >= 0 ? norm(r[rollIdx])  : norm(r[0]);
    const name   = nameIdx  >= 0 ? String(r[nameIdx] || "").trim() : String(r[2] || "").trim();
    const device = devIdx   >= 0 ? norm(r[devIdx])   : norm(r[3]);
    const rawRoll = rollIdx >= 0 ? String(r[rollIdx] || "").trim() : String(r[0] || "").trim();

    const rec = { row: i + 1, roll: rawRoll, name, device };
    if (roll)   rollMap[roll]     = rec;
    if (device) deviceMap[device] = rec;
  }

  const bundle = { rollMap, deviceMap, devColIdx, statusColIdx, countColIdx };
  cache.put(cacheKey, JSON.stringify(bundle), ATT_STUDENT_CACHE_TTL);
  return bundle;
}

function attInvalidateStudentsCache_() {
  CacheService.getScriptCache().remove("att_students_v1");
}

/* QR lifetime, read from the Config sheet with a safe fallback + sane bounds */
function attQrValiditySec_() {
  const v = parseInt(attGetConfig_("qr_validity_sec"), 10);
  if (isNaN(v) || v <= 0) return ATT_QR_VALIDITY_SEC;
  return Math.min(Math.max(v, 5), 3600);   // clamp 5s..1h
}

function attQrGraceSec_() {
  const raw = attGetConfig_("qr_grace_sec");
  if (raw === "") return ATT_QR_GRACE_SEC;   // key absent → default
  const v = parseInt(raw, 10);
  if (isNaN(v) || v < 0) return ATT_QR_GRACE_SEC;
  return Math.min(v, 300);   // clamp 0..5min
}

function attGetConfig_(key) {
  const cache    = CacheService.getScriptCache();
  const cacheKey = "att_config_v1";
  let map        = cache.get(cacheKey);

  if (map) {
    map = JSON.parse(map);
    return String(map[key] || "").trim();
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Config");
  if (!sheet) return "";

  map = {};
  sheet.getDataRange().getValues().forEach(r => {
    const k = String(r[0] || "").trim();
    if (k) map[k] = String(r[1] || "").trim();
  });

  cache.put(cacheKey, JSON.stringify(map), ATT_CONFIG_CACHE_TTL);
  return String(map[key] || "").trim();
}

function attGetSessions_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Config");
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0] || "").trim().toLowerCase() === "sessions") {
      return String(data[i][1] || "").split(",").map(s => s.trim()).filter(Boolean);
    }
  }
  return [];
}

function attSignature_(session_id, timestamp, token, secret) {
  const raw  = session_id + "|" + timestamp + "|" + token + "|" + secret;
  const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw, Utilities.Charset.UTF_8);
  return hash.map(b => { const v = (b < 0 ? b + 256 : b).toString(16); return v.length === 1 ? "0" + v : v; }).join("");
}
