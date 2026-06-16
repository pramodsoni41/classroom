/* ============================================================
   CLASSROOM + QUIZ — UNIFIED BACKEND  (single spreadsheet)
   Bind this script to ONE spreadsheet that holds ALL tabs:
     Students, LoginLogs, Messages, Tokens,
     Marks, Attendance, Notes, Announcements,
     QuizConfig, Q_<QuizId>, Resp_<QuizId>
   Everything uses getActiveSpreadsheet() — no external sheet IDs.
   ============================================================ */

/* =========================
   CONFIG
========================= */

const STUDENT_TAB = "Students";

const SHEET_MARKS = "Marks";
const SHEET_ATTENDANCE = "Attendance";
const SHEET_NOTES = "Notes";
const SHEET_ANNOUNCEMENTS = "Announcements";
const SHEET_LOGIN_LOGS = "LoginLogs";

const QUIZ_SESSION_PREFIX = "quizsess_";
const QUIZ_SESSION_TTL_SEC = 6 * 60 * 60;

/* =========================
   ROUTER — GET (classroom)
========================= */

function doGet(e) {
  const action = String(e.parameter.action || "").trim();
  const callback = e.parameter.callback || null;

  if (action === "dashboard") return dashboard(e);
  if (action === "changePassword") return changePassword(e);
  if (action === "googleLogin") return googleLogin(e);

  if (action === "submitMessage") {
    return jsonOutput(submitMessage(e), callback);
  }

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
    courses.includes(String(r.Course || "").trim())
  );

  const filteredAnnouncements = announcements.filter(r =>
    courses.includes(String(r.Course || "").trim())
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
