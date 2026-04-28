// ==========================
// CONFIG
// ==========================
const API_URL = "https://script.google.com/macros/s/AKfycbycGypy0XnE0RO9KQqa6ZbKyB3uinufXaq6h1FDqSQok5mqDTb5ecp7-v7I9jkLckXb/exec";

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

  const roll = localStorage.getItem("student_roll");

  if (!roll) {
    return redirect("index.html");
  }

  try {

    const url = `${API_URL}?action=dashboard&roll=${encodeURIComponent(roll)}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== "success") {
      alert(data.message);
      return logout();
    }

    dashboardData = data;

    renderStudent(data.student);
    renderCourses(data.student.Courses);

    if (data.student.Courses?.length) {
      selectCourse(data.student.Courses[0]);
    }

  } catch {
    document.body.innerHTML = "<h3 style='padding:20px;'>Unable to load dashboard.</h3>";
  }
}


// ==========================
// RENDER STUDENT
// ==========================
function renderStudent(student) {
  $("studentInfo").innerText = `${student.Name} | ${student.RollNo}`;
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

  renderMarks(marks);
  renderAttendance(attendance);
  renderNotes(notes);
  renderAnnouncements(announcements);
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

  if (!list.length) {
    return box.innerHTML = "<p>No marks uploaded.</p>";
  }

  const m = list[0];

  let html = "<table>";
  let hasData = false;

  Object.keys(m).forEach(key => {

    // Skip non-mark fields
    if (key === "RollNo" || key === "Course") return;

    // Skip empty / null / undefined fields
    if (
      m[key] === "" ||
      m[key] === null ||
      m[key] === undefined
    ) return;

    hasData = true;

    html += `
      <tr>
        <td>${key}</td>
        <td>${m[key]}</td>
      </tr>
    `;
  });

  html += "</table>";

  box.innerHTML = hasData
    ? html
    : "<p>No marks uploaded.</p>";
}


// ==========================
// ATTENDANCE
// ==========================
function renderAttendance(list) {

  const box = $("attendance");

  if (!list.length) {
    return box.innerHTML = "<p>No attendance uploaded.</p>";
  }

  let html = "";

  list.forEach(a => {

    html += "<table>";

    Object.keys(a).forEach(key => {
      if (key !== "RollNo" && key !== "Course") {
        html += `<tr><td>${key}</td><td>${a[key]}</td></tr>`;
      }
    });

    html += "</table>";
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

  box.innerHTML = list.map(n => `
    <div class="card">
      <h4>${n.Title}</h4>
      <p>${n.Description || ""}</p>
      <p class="date">${n.Date || ""}</p>
      <a href="${n.Link}" target="_blank">Open Notes</a>
    </div>
  `).join("");
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
  <div class="card">
    <h4>${a.Announcement || "-"}</h4>
    <p>${a.Description || ""}</p>
    ${a.Date ? `<p class="date">${new Date(a.Date).toLocaleDateString('en-IN')}</p>` : ""}
    ${a.Link ? `<a href="${a.Link}" target="_blank">Open</a>` : ""}
  </div>
`).join("");
}
// ==========================
// QUIZ BUTTON (WORKING VERSION)
// ==========================
async function goToQuiz() {

  const roll = localStorage.getItem("student_roll");
  const name = localStorage.getItem("student_name");
  const password = localStorage.getItem("student_pass");
  const phone = localStorage.getItem("student_phone");



  // Open new tab directly (no popup)
  const newTab = window.open("", "_blank");

  const quizURL =
    `https://pramodsoni.in/Quiz/?roll=${encodeURIComponent(roll)}`
    + `&password=${encodeURIComponent(password)}`
    + `&name=${encodeURIComponent(name || "")}`
    + `&phone=${encodeURIComponent(phone || "")}`;

  newTab.location.href = quizURL;
}
function submitStudentMessage() {
  const msg = document.getElementById("studentMessage").value.trim();
  const status = document.getElementById("messageStatus");

  if (!msg) {
    status.innerText = "Please enter your message first.";
    status.style.color = "red";
    return;
  }

  const student = JSON.parse(localStorage.getItem("student"));

  if (!student || !student.roll) {
    status.innerText = "Student information not found.";
    status.style.color = "red";
    return;
  }

  fetchJSONP(
    GOOGLE_SCRIPT_URL +
    "?action=submitMessage" +
    "&roll=" + encodeURIComponent(student.roll) +
    "&name=" + encodeURIComponent(student.name || "") +
    "&message=" + encodeURIComponent(msg)
  )
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

  // DO NOT remove device_id

  redirect("index.html");
}


// ==========================
// INIT
// ==========================
