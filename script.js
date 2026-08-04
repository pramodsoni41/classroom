// ==========================
// CONFIG
// ==========================
const API_URL = "https://script.google.com/macros/s/AKfycbxOD9kZJmk3uJtPHb-DiVWncREfAs7OLWATUMRkL3PV0FEhDOdJjEphbyvqFUGoY43I/exec";
const GOOGLE_CLIENT_ID = "589647151742-imup6ivhj023l40d9flhggpgg04juqbu.apps.googleusercontent.com";

let dashboardData = null;
let selectedCourse = null;


// ==========================
// HELPERS
// ==========================
function $(id) {
  return document.getElementById(id);
}

function setMessage(el, text, color = "red") {
  if (!el) return;
  el.innerText = text;
  el.style.color = color;
}

function redirect(page) {
  window.location.href = page;
}

/* Fetch JSON with retry — Apps Script's 302→googleusercontent.com/macros/echo
   redirect intermittently 404s. Retrying with a short backoff self-heals it. */
async function fetchJSON(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await new Promise(r => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw lastErr;
}


// ==========================
// GOOGLE LOGIN
// ==========================
async function handleGoogleCredential(response) {
  const msg = $("loginMessage");
  setMessage(msg, "Verifying with Google...", "#555");

  try {
    const url = `${API_URL}?action=googleLogin&token=${encodeURIComponent(response.credential)}`;
    const data = await fetchJSON(url);

    if (data.status !== "success") {
      return setMessage(msg, data.message || "Google account not registered. Contact instructor.");
    }

    // Collect device info same as password login
    let deviceId = localStorage.getItem("device_id");
    if (!deviceId) {
      deviceId = "DEV-" + Math.random().toString(36).substring(2, 10) + "-" + Date.now();
      localStorage.setItem("device_id", deviceId);
    }
    localStorage.setItem("device", deviceId);

    // Store Google session
    localStorage.setItem("student_roll",          data.student.RollNo);
    localStorage.setItem("student_name",          data.student.Name);
    localStorage.setItem("student_phone",         data.student.Phone || "");
    localStorage.setItem("student_auth_type",     "google");
    localStorage.setItem("student_session_token", data.sessionToken);
    localStorage.setItem("student_pass",          data.student.Password || "");

    redirect("dashboard.html");

  } catch (err) {
    setMessage(msg, "Server error. Try again.");
  }
}


// ==========================
// LOGIN (CLASSROOM ONLY)
// ==========================
async function login() {

  const roll = $("roll").value.trim();
  const password = $("password").value.trim();
  const msg = $("loginMessage");

  if (!roll || !password) {
    return setMessage(msg, "Enter roll and password.");
  }

  setMessage(msg, "Checking...", "#555");

  try {

    const browser = navigator.userAgent;

const device = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)
  ? "Mobile"
  : "Desktop";
let deviceId = localStorage.getItem("device_id");

if (!deviceId) {
  deviceId =
    "DEV-" +
    Math.random().toString(36).substring(2, 10) +
    "-" +
    Date.now();

  localStorage.setItem("device_id", deviceId);
}
let ip = "";

try {
  const ipRes = await fetch("https://api.ipify.org?format=json");
  const ipData = await ipRes.json();
  ip = ipData.ip || "";
} catch (e) {
  ip = "";
}
let latitude = "";
let longitude = "";
let accuracy = "";

try {
  const position = await new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      resolve,
      reject,
      {
        enableHighAccuracy: true,
        timeout: 8000,
        maximumAge: 0
      }
    );
  });

  latitude = position.coords.latitude || "";
  longitude = position.coords.longitude || "";
  accuracy = position.coords.accuracy || "";

} catch (e) {
  latitude = "";
  longitude = "";
  accuracy = "";
}
const url =
  `${API_URL}?action=login`
  + `&roll=${encodeURIComponent(roll)}`
  + `&password=${encodeURIComponent(password)}`
  + `&browser=${encodeURIComponent(browser)}`
  + `&device=${encodeURIComponent(device)}`
  + `&deviceId=${encodeURIComponent(deviceId)}`
  + `&ip=${encodeURIComponent(ip)}`
  + `&latitude=${encodeURIComponent(latitude)}`
  + `&longitude=${encodeURIComponent(longitude)}`
  + `&accuracy=${encodeURIComponent(accuracy)}`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== "success") {
      return setMessage(msg, data.message || "Invalid login.");
    }
localStorage.setItem("student_device", device);
localStorage.setItem("student_browser", browser);
// Sync device_id to "device" key so attendance page uses the same device fingerprint
localStorage.setItem("device", deviceId);
    // Save session
    localStorage.setItem("student_roll", data.student.RollNo);
    localStorage.setItem("student_name", data.student.Name);
    localStorage.setItem("student_phone", data.student.Phone || "");
localStorage.setItem("student_pass", password);   // ✅ ADD THIS
    redirect("dashboard.html");

  } catch (err) {
    setMessage(msg, "Server error. Try again.");
  }
}


// ==========================
// LOAD DASHBOARD
// ==========================
async function loadDashboard() {

  if (!window.location.pathname.includes("dashboard.html")) return;

  const roll      = localStorage.getItem("student_roll");
  const authType  = localStorage.getItem("student_auth_type") || "password";
  const password  = localStorage.getItem("student_pass");
  const sessionToken = localStorage.getItem("student_session_token");

  if (!roll || (authType === "google" && !sessionToken) || (authType === "password" && !password)) {
    alert("Session expired. Please login again.");
    return redirect("index.html");
  }

  try {

    let url = `${API_URL}?action=dashboard&roll=${encodeURIComponent(roll)}`;
    if (authType === "google") {
      url += `&sessionToken=${encodeURIComponent(sessionToken)}`;
    } else {
      url += `&password=${encodeURIComponent(password)}`;
    }

    const data = await fetchJSON(url);

    if (data.status !== "success") {
      alert(data.message || "Unauthorized access");
      return logout();
    }

    dashboardData = data;

    renderStudent(data.student);
    renderCourses(data.student.Courses);

    if (data.student.Courses?.length) {
      selectCourse(data.student.Courses[0]);
    }

  } catch {
    document.body.innerHTML =
      "<h3 style='padding:20px;'>Unable to load dashboard.</h3>";
  }
}


// ==========================
// RENDER STUDENT
// ==========================
function renderStudent(student) {
  $("studentInfo").innerText = `${student.Name} | ${student.RollNo}`;
}

// ==========================
// MARK ATTENDANCE (direct — gated by Config sheet)
// ==========================
/* Show the button for the selected course, only if that course is open in Config. */
function renderMarkAttendance(course) {
  const section = $("markAttendanceSection");
  if (!section || !dashboardData) return;

  const openCourses = dashboardData.attendanceOpenCourses || [];
  const markedMap   = dashboardData.attendanceMarked || {};
  const isOpen = openCourses.map(c => c.toUpperCase()).includes(String(course).toUpperCase());

  if (!isOpen) { section.style.display = "none"; return; }

  section.style.display = "";
  $("attSessionLabel").innerText = `Course: ${course}`;
  $("markAttendanceBtn").disabled = false;   // duplicates allowed — never lock

  if (markedMap[course]) {
    setMessage($("attendanceStatus"), "ℹ️ Already marked today for " + course + " — you can mark again.", "#0891b2");
  } else {
    $("attendanceStatus").innerText = "";
  }
}

async function markAttendance() {
  const btn   = $("markAttendanceBtn");
  const status = $("attendanceStatus");
  const sessionToken = localStorage.getItem("student_session_token");
  const device = localStorage.getItem("device") || "";
  const course = selectedCourse;

  if (!sessionToken) {
    setMessage(status, "Session expired. Please log in again.", "#ef4444");
    return;
  }
  if (!course) {
    setMessage(status, "Select a course first.", "#ef4444");
    return;
  }

  btn.disabled = true;

  // 1. Real GPS is mandatory
  if (!navigator.geolocation) {
    setMessage(status, "❌ GPS not supported on this device.", "#ef4444");
    btn.disabled = false;
    return;
  }

  setMessage(status, "📍 Getting your location...", "#64748b");

  let pos;
  try {
    pos = await new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true, timeout: 15000, maximumAge: 0
      })
    );
  } catch (err) {
    const msg = {
      1: "❌ Location denied. Enable GPS/location permission and try again.",
      2: "❌ Location unavailable. Move to an open area and retry.",
      3: "❌ Location timed out. Try again."
    };
    setMessage(status, msg[err && err.code] || "❌ Could not get location.", "#ef4444");
    btn.disabled = false;
    return;
  }

  const lat = pos.coords.latitude.toFixed(6);
  const lon = pos.coords.longitude.toFixed(6);

  // 2. Send to server (which geofences against class_lat/class_lon/allowed_radius)
  setMessage(status, "Marking...", "#64748b");

  try {
    const url = `${API_URL}?action=markPresent`
      + `&sessionToken=${encodeURIComponent(sessionToken)}`
      + `&course=${encodeURIComponent(course)}`
      + `&device_id=${encodeURIComponent(device)}`
      + `&lat=${encodeURIComponent(lat)}`
      + `&lon=${encodeURIComponent(lon)}`;
    const data = await fetchJSON(url);

    if (data.status === "success") {
      setMessage(status,
        data.duplicate
          ? `✅ Marked again for ${course} (already marked today)`
          : `✅ Present — ${data.name} (${course})`,
        "#16a34a");
      btn.disabled = false;   // duplicates allowed — stay clickable
      if (dashboardData && dashboardData.attendanceMarked) dashboardData.attendanceMarked[course] = true;
    } else if (data.status === "no_gps") {
      setMessage(status, "❌ Location missing. Try again.", "#ef4444");
      btn.disabled = false;
    } else if (data.status === "closed") {
      setMessage(status, `Attendance is not open for ${course}.`, "#f59e0b");
      $("markAttendanceSection").style.display = "none";
    } else if (data.status === "not_enrolled") {
      setMessage(status, `You are not enrolled in ${course}.`, "#ef4444");
    } else if (data.status === "unauthorized") {
      setMessage(status, "Session expired. Please log in again.", "#ef4444");
    } else {
      setMessage(status, data.message || "Could not mark attendance.", "#ef4444");
      btn.disabled = false;
    }
  } catch (err) {
    setMessage(status, "Network error. Try again.", "#ef4444");
    btn.disabled = false;
  }
}


// ==========================
// COURSES
// ==========================
function renderCourses(courses) {

  const box = $("courseTabs");

  if (!courses || courses.length === 0) {
    box.innerHTML = "<p>No courses found.</p>";
    return;
  }

  box.innerHTML = courses.map(c =>
    `<button class="course-btn" onclick="selectCourse('${c}')">${c}</button>`
  ).join("");
}


// ==========================
// SELECT COURSE
// ==========================
function selectCourse(course) {

  selectedCourse = course;

  $("selectedCourseTitle").innerText = `${course} Dashboard`;

  document.querySelectorAll(".course-btn").forEach(btn => {
    btn.classList.toggle("active-course", btn.innerText === course);
  });

  const marks = filterByCourse(dashboardData.marks, course);
  const attendance = filterByCourse(dashboardData.attendance, course);
  const notes = filterByCourse(dashboardData.notes, course);
  const announcements = dashboardData.announcements.filter(a =>
    String(a.Course || "").trim().toUpperCase() === course.trim().toUpperCase()
  );
  const quizzes = (dashboardData.quizzes || []).filter(q => {
    const qCourse = String(q.Course || "").trim().toUpperCase();
    return qCourse === "" || qCourse === "ALL" || qCourse === course.trim().toUpperCase();
  });

  renderMarks(marks);
  renderAttendance(attendance);
  renderNotes(notes);
  renderAnnouncements(announcements);
  renderQuizzes(quizzes);
  renderMarkAttendance(course);
}


// ==========================
// FILTER
// ==========================
function filterByCourse(data, course) {
  if (!data) return [];
  return data.filter(row => String(row.Course).trim() === course);
}


// ==========================
// MARKS
// ==========================
function renderMarks(list) {
  const box = $("marks");
  if (!list.length) { box.innerHTML = "<p style='color:#94a3b8;font-size:14px;'>No marks uploaded.</p>"; return; }

  const m = list[0];
  let rows = "";
  let hasData = false;

  Object.keys(m).forEach(key => {
    if (key === "RollNo" || key === "Course") return;
    if (m[key] === "" || m[key] === null || m[key] === undefined) return;
    hasData = true;
    rows += `<tr><td>${key}</td><td>${m[key]}</td></tr>`;
  });

  box.innerHTML = hasData
    ? `<table class="stat-table">${rows}</table>`
    : "<p style='color:#94a3b8;font-size:14px;'>No marks uploaded.</p>";
}


// ==========================
// ATTENDANCE
// ==========================
function renderAttendance(list) {
  const box = $("attendance");
  if (!list.length) { box.innerHTML = "<p style='color:#94a3b8;font-size:14px;'>No attendance uploaded.</p>"; return; }

  let html = "";
  list.forEach(a => {
    let rows = "";
    Object.keys(a).forEach(key => {
      if (key !== "RollNo" && key !== "Course") {
        rows += `<tr><td>${key}</td><td>${a[key]}</td></tr>`;
      }
    });
    html += `<table class="stat-table">${rows}</table>`;
  });

  box.innerHTML = html;
}


// ==========================
// NOTES
// ==========================
function renderNotes(list) {

  const box = $("notes");

  if (!list.length) {
    return box.innerHTML = "<p>No notes uploaded.</p>";
  }

  box.innerHTML = list.map(n => {
    const dateStr = n.Date ? new Date(n.Date).toLocaleDateString('en-IN', {day:'numeric', month:'short', year:'numeric'}) : "";
    const inner = `
      <div class="note-card-accent"></div>
      <div class="note-card-body">
        <h4>${n.Title}</h4>
        ${n.Description ? `<p>${n.Description}</p>` : ""}
        ${dateStr ? `<p class="date">📅 ${dateStr}</p>` : ""}
      </div>`;
    return n.Link
      ? `<a href="${n.Link}" target="_blank" class="note-card">${inner}</a>`
      : `<div class="note-card">${inner}</div>`;
  }).join("");
}


// ==========================
// ANNOUNCEMENTS
// ==========================
function renderAnnouncements(list) {

  const box = $("announcements");

  if (!list.length) {
    return box.innerHTML = "<p>No announcements.</p>";
  }

  box.innerHTML = list.map(a => `
    <div class="ann-card">
      <h4>${a.Announcement || "-"}</h4>
      ${a.Description ? `<p>${a.Description}</p>` : ""}
      ${a.Date ? `<p class="date">📅 ${new Date(a.Date).toLocaleDateString('en-IN', {day:'numeric',month:'short',year:'numeric'})}</p>` : ""}
      ${a.Link ? `<a href="${a.Link}" target="_blank">🔗 View</a>` : ""}
    </div>
  `).join("");
}
// ==========================
// QUIZ PORTAL — open quiz tab
// The student is already logged into the classroom. The quiz reads the
// classroom session from shared localStorage (same domain). The class
// password is asked for, and verified server-side, ON the quiz portal.
// No roll/password/quiz details are placed in the URL.
// ==========================
function openQuiz(quizURL) {
  if (!quizURL) {
    alert("This quiz has no link configured. Contact your instructor.");
    return;
  }
  window.open(quizURL, "_blank");
}


// ==========================
// QUIZZES
// ==========================
function renderQuizzes(list) {
  const box = $("quizzes");
  if (!box) return;

  if (!list || !list.length) {
    box.innerHTML = "<p>No quizzes available for this course.</p>";
    return;
  }

  const statusColors = {
    OPEN:     "#10b981",
    UPCOMING: "#f59e0b",
    EXPIRED:  "#94a3b8",
    CLOSED:   "#94a3b8"
  };

  box.innerHTML = list.map((q) => {
    const color    = statusColors[q.Status] || "#94a3b8";
    const canStart = q.Status === "OPEN";
    const hasPass  = !!(q.ClassPassword && String(q.ClassPassword).trim());
    const quizURL  = (q.URL || "").replace(/'/g, "\\'");

    return `
      <div class="quiz-card">
        <div class="quiz-card-header">
          <div class="quiz-card-title">${q.QuizName}</div>
          <span class="status-badge" style="background:${color};color:#fff;">${q.Status}</span>
        </div>
        <div class="quiz-meta">
          <div class="quiz-meta-row">📅 <span>${q.OpenDate || "—"} → ${q.CloseDate || "—"}</span></div>
          <div class="quiz-meta-row">🎯 <span>+${q.CorrectMarks} correct &nbsp;/&nbsp; ${q.NegativeMarks} incorrect</span></div>
          ${hasPass ? `<div class="quiz-meta-row">🔒 <span>Class password required</span></div>` : ""}
        </div>
        ${canStart
          ? `<button class="quiz-start-btn" onclick="openQuiz('${quizURL}')">Start Quiz →</button>`
          : `<button class="quiz-start-btn" disabled>${q.Status === "UPCOMING" ? "⏳ Not Open Yet" : "🔒 Closed"}</button>`
        }
      </div>
    `;
  }).join("");
}
function fetchJSONP(url) {
  return new Promise((resolve, reject) => {
    const callbackName =
      "jsonp_callback_" + Math.round(100000 * Math.random());

    window[callbackName] = function (data) {
      delete window[callbackName];
      document.body.removeChild(script);
      resolve(data);
    };

    const script = document.createElement("script");
    script.src =
      url + (url.includes("?") ? "&" : "?") + "callback=" + callbackName;

    script.onerror = function () {
      delete window[callbackName];
      document.body.removeChild(script);
      reject(new Error("JSONP request failed"));
    };

    document.body.appendChild(script);
  });
}
function submitStudentMessage() {
  const msg = document.getElementById("studentMessage").value.trim();
  const status = document.getElementById("messageStatus");

  if (!msg) {
    status.innerText = "Please enter your message first.";
    status.style.color = "red";
    return;
  }

  const roll = localStorage.getItem("student_roll");
  const name = localStorage.getItem("student_name");

  if (!roll) {
    status.innerText = "Student information not found.";
    status.style.color = "red";
    return;
  }

  const url =
    `${API_URL}?action=submitMessage`
    + `&roll=${encodeURIComponent(roll)}`
    + `&name=${encodeURIComponent(name || "")}`
    + `&message=${encodeURIComponent(msg)}`;

  fetchJSONP(url)
    .then(res => {
      if (res.status === "success") {
        status.innerText = "Message submitted successfully.";
        status.style.color = "green";
        document.getElementById("studentMessage").value = "";
      } else {
        status.innerText = res.message || "Failed to submit message.";
        status.style.color = "red";
      }
    })
    .catch(err => {
      console.error(err);
      status.innerText = "Submission failed.";
      status.style.color = "red";
    });
}
async function changePasswordFromLogin() {

  const roll = $("rollChange").value.trim();
  const oldPass = $("oldPass").value.trim();
  const newPass = $("newPass").value.trim();
  const msg = $("changeMessage");

  if (!roll || !oldPass || !newPass) {
    return setMessage(msg, "Fill all fields.");
  }

  const url = `${API_URL}?action=changePassword`
    + `&roll=${encodeURIComponent(roll)}`
    + `&oldPassword=${encodeURIComponent(oldPass)}`
    + `&newPassword=${encodeURIComponent(newPass)}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== "success") {
      return setMessage(msg, data.message || "Password update failed.");
    }

    setMessage(msg, "Password updated successfully. Please login.", "green");

    $("rollChange").value = "";
    $("oldPass").value = "";
    $("newPass").value = "";

    setTimeout(() => {
      closeModal();
    }, 1500);

  } catch {
    setMessage(msg, "Server error while updating password.");
  }
}

// ==========================
// CHANGE PASSWORD
// ==========================
async function changePassword() {

  const roll = localStorage.getItem("student_roll");

  const oldPassEl = $("oldPass");
  const newPassEl = $("newPass");
  const confirmPassEl = $("confirmPass");
  const msg = $("passMsg");

  if (!oldPassEl || !newPassEl || !confirmPassEl || !msg) {
    alert("Password modal fields not found.");
    return;
  }

  const oldPass = oldPassEl.value.trim();
  const newPass = newPassEl.value.trim();
  const confirmPass = confirmPassEl.value.trim();

  if (!oldPass || !newPass || !confirmPass) {
    return setMessage(msg, "Fill all fields.");
  }

  if (newPass !== confirmPass) {
    return setMessage(msg, "Passwords do not match.");
  }

  try {

    const url = `${API_URL}?action=changePassword`
      + `&roll=${encodeURIComponent(roll)}`
      + `&oldPassword=${encodeURIComponent(oldPass)}`
      + `&newPassword=${encodeURIComponent(newPass)}`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== "success") {
      return setMessage(msg, data.message);
    }

setMessage(msg, "Password updated. Login again.", "green");

$("oldPass").value = "";
$("newPass").value = "";
$("confirmPass").value = "";

closePasswordModal();

setTimeout(() => {
  logout();
}, 1500);

  } catch {
    setMessage(msg, "Error updating password.");
  }
}

function openPasswordModal() {
  const modal = document.getElementById("passwordModal");
  if (modal) {
    modal.style.display = "flex";
  }
}

function closePasswordModal() {
  const modal = document.getElementById("passwordModal");
  if (modal) {
    modal.style.display = "none";
  }
}
// ==========================
// LOGOUT
// ==========================
function logout() {
  localStorage.removeItem("student_roll");
  localStorage.removeItem("student_name");
  localStorage.removeItem("student_phone");
  localStorage.removeItem("student_pass");
  localStorage.removeItem("student_device");
  localStorage.removeItem("student_browser");
  localStorage.removeItem("student_auth_type");
  localStorage.removeItem("student_session_token");

  // Sign out of Google silently so next visit shows the account picker
  if (typeof google !== "undefined") {
    google.accounts.id.disableAutoSelect();
  }

  // DO NOT remove device_id

  redirect("index.html");
}


// ==========================
// INIT
// ==========================
